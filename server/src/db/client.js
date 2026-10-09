/**
 * Turso (libSQL) database access layer. Replaces the former PostgreSQL pool.
 *
 * Design:
 *  - One libSQL client per process. Statements are serialized through a promise
 *    queue: a single libSQL connection cannot run a statement while a transaction
 *    is open, and SQLite allows only one writer at a time anyway.
 *  - withTransaction() runs a BEGIN IMMEDIATE-style ("write") transaction. Queries
 *    issued inside it (through the callback's `tx` argument or plain query() calls
 *    made while the transaction is active, via AsyncLocalStorage) are routed to it.
 *  - query() returns { rows, rowCount } like the pg driver did. rowCount is the
 *    number of rows returned, or rowsAffected for statements that return none.
 *  - Values are normalized (booleans, timestamps, JSON, blobs) by column name.
 *  - Database errors are thrown as DbError with a normalized `code`.
 *
 * Foreign keys: local files enforce them (PRAGMA foreign_keys=ON per connection).
 * Remote Turso sessions may not keep pragmas between requests, so enforcement is
 * probed at startup (probeForeignKeys) and reported by /api/health and db:check.
 */
import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config/index.js';
import { describeDatabaseTarget, scrubDatabaseSecrets } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { DbError, mapDbError, safeDbDiagnostics } from './errors.js';
import { assertPlaceholders, rowToObject, toDbArg, stripLiteralsAndComments } from './values.js';

const txStore = new AsyncLocalStorage();
let state = null; // { client, kind, safeDescription, foreignKeys }
// Set only while the startup foreign-key probe runs: its deliberate violation is not an error.
let quietConstraintLog = false;
let queue = Promise.resolve();
const SLOW_QUERY_MS = 1000;
const CONSTRAINT_CODES = new Set(['UNIQUE_VIOLATION', 'FOREIGN_KEY_VIOLATION', 'NOT_NULL_VIOLATION', 'CHECK_VIOLATION', 'RAISED']);

function exclusive(task) {
  const run = queue.then(() => task());
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function openState() {
  const target = describeDatabaseTarget(config.db, { isProd: config.isProd, isTest: config.isTest });
  if (target.problems.length) {
    throw new Error(`Invalid database configuration: ${target.problems.join('; ')}`);
  }
  const client =
    target.kind === 'file'
      ? createClient({ url: config.db.url, concurrency: 1 })
      : createClient({ url: config.db.url, authToken: config.db.authToken || undefined });
  return { client, kind: target.kind, safeDescription: target.safeDescription, foreignKeys: 'unknown' };
}

function getState() {
  if (!state) state = openState();
  return state;
}

/** Description safe for logs and the health endpoint: host or file name only. */
export function databaseDescription() {
  return getState().safeDescription;
}

function firstLine(sql) {
  // Never log literal values or comments (which can carry imported data).
  return stripLiteralsAndComments(String(sql)).trim().split('\n')[0].slice(0, 120);
}

function toResult(rs) {
  const columns = rs.columns ?? [];
  const rows = (rs.rows ?? []).map((row) => rowToObject(row, columns));
  const rowCount = rows.length > 0 ? rows.length : Number(rs.rowsAffected ?? 0);
  return { rows, rowCount, fields: columns.map((name) => ({ name })) };
}

async function runOn(target, text, params) {
  const sql = String(text);
  const args = Array.isArray(params) ? params : [];
  assertPlaceholders(sql, args);
  const dbArgs = args.map(toDbArg);
  const started = Date.now();
  let rs;
  try {
    rs = await target.execute({ sql, args: dbArgs });
  } catch (err) {
    const mapped = mapDbError(err);
    const code = mapped?.code ?? 'UNKNOWN';
    const meta = {
      code, sqliteCode: mapped?.sqliteCode ?? null, constraint: mapped?.constraint ?? null,
      statement: firstLine(sql),
      ...(!config.isProd ? { diagnostic: safeDbDiagnostics(err) } : {}),
    };
    if (CONSTRAINT_CODES.has(code)) {
      if (!quietConstraintLog) logger.warn('database constraint rejected a statement', meta);
    }
    else logger.error('database query failed', meta);
    throw mapped;
  }
  const elapsed = Date.now() - started;
  if (elapsed > SLOW_QUERY_MS) logger.warn('slow database query', { ms: elapsed, statement: firstLine(sql) });
  return toResult(rs);
}

class Transaction {
  constructor(libsqlTx) {
    this.libsqlTx = libsqlTx;
    this.active = true;
  }

  query(text, params = []) {
    if (!this.active) return Promise.reject(new DbError('DB_ERROR', 'Transaction is no longer active'));
    return runOn(this.libsqlTx, text, params);
  }
}

/** Tables whose rows carry the money / share invariants (see migration 001, "Deferred money / share invariants"). */
const INVARIANT_WRITE = /^\s*(insert|update|delete|replace)\b[\s\S]*\b(installments|nominees|investments)\b/i;

/**
 * Runs a SQL statement. `client` is an optional transaction handle from
 * withTransaction(); when omitted, the active transaction (if any) is used.
 * A bare write to an invariant table outside a transaction runs in its own write
 * transaction so the deferred money/share rules are checked at the end of the
 * statement (PostgreSQL checked them at COMMIT).
 * @returns {Promise<{rows: object[], rowCount: number, fields: {name: string}[]}>}
 */
export async function query(text, params = [], client = undefined) {
  if (client && typeof client.query === 'function') return client.query(text, params);
  const current = txStore.getStore();
  if (current?.active) return current.query(text, params);
  if (INVARIANT_WRITE.test(String(text))) {
    return withTransaction((tx) => tx.query(text, params));
  }
  return exclusive(() => runOn(getState().client, text, params));
}

const TXN_TABLES_DDL = [
  'CREATE TABLE IF NOT EXISTS txn_scope (id INTEGER PRIMARY KEY CHECK (id = 1))',
  `CREATE TABLE IF NOT EXISTS txn_deferred_checks (
     kind TEXT NOT NULL CHECK (kind IN ('INVESTMENT_SUM', 'NOMINEE_SHARES')),
     ref_id INTEGER NOT NULL,
     PRIMARY KEY (kind, ref_id))`,
];
let txnTablesReady = false;

async function ensureTxnTables() {
  if (txnTablesReady) return;
  for (const ddl of TXN_TABLES_DDL) await query(ddl);
  txnTablesReady = true;
}

/**
 * Commit-time check of the deferred invariants recorded by the triggers during this
 * transaction. Throws a DbError (rolling the whole transaction back) on a violation.
 */
async function verifyDeferredChecks(tx) {
  const failed = await tx.query(
    `select 'INVESTMENT_SUM' as kind, v.id as ref_id
       from investments v
       join txn_deferred_checks d on d.kind = 'INVESTMENT_SUM' and d.ref_id = v.id
      where (select count(*) from installments i where i.investment_id = v.id) > 0
        and (select coalesce(sum(i.amount), 0) from installments i where i.investment_id = v.id) <> v.total_amount
     union all
     select 'NOMINEE_SHARES', d.ref_id
       from txn_deferred_checks d
      where d.kind = 'NOMINEE_SHARES'
        and (select count(*) from nominees n where n.investor_id = d.ref_id) > 0
        and (cast(round((select coalesce(sum(n.share_percent), 0) from nominees n where n.investor_id = d.ref_id) * 100) as integer) <> 10000
             or (select count(*) from nominees n where n.investor_id = d.ref_id) > 3)
     limit 1`,
  );
  if (failed.rows[0]) {
    const message =
      failed.rows[0].kind === 'INVESTMENT_SUM'
        ? 'Installments must total the investment total'
        : 'Nominee shares must total 100% (and an investor can have at most 3 nominees)';
    throw new DbError('RAISED', message, { constraint: failed.rows[0].kind });
  }
  await tx.query('DELETE FROM txn_deferred_checks');
  await tx.query('DELETE FROM txn_scope');
}

/**
 * Runs `fn(tx)` inside a write transaction. Commits when fn resolves, rolls back
 * when it throws. Nested calls join the outer transaction. Deferred money/share
 * invariants are verified just before COMMIT.
 */
export async function withTransaction(fn) {
  const current = txStore.getStore();
  if (current?.active) return fn(current);

  await ensureTxnTables();
  return exclusive(async () => {
    let libsqlTx;
    try {
      libsqlTx = await getState().client.transaction('write');
    } catch (err) {
      throw mapDbError(err);
    }
    const tx = new Transaction(libsqlTx);
    let committed = false;
    try {
      // Marks this write transaction: invariant triggers now record instead of raising.
      await libsqlTx.execute('INSERT INTO txn_scope (id) VALUES (1)');
      const result = await txStore.run(tx, () => fn(tx));
      await verifyDeferredChecks(tx);
      try {
        await libsqlTx.commit();
      } catch (err) {
        throw mapDbError(err);
      }
      committed = true;
      return result;
    } catch (err) {
      tx.active = false;
      if (!committed) {
        try {
          await libsqlTx.rollback();
        } catch (rollbackErr) {
          logger.error('database rollback failed', { code: mapDbError(rollbackErr)?.code ?? 'UNKNOWN' });
        }
      }
      throw err;
    } finally {
      tx.active = false;
      try {
        libsqlTx.close();
      } catch {
        // already closed
      }
    }
  });
}

/**
 * Opens the connection and verifies it with a trivial query. Enables foreign keys
 * for local files. Throws a sanitized Error with an actionable message on failure.
 */
export async function connectDatabase() {
  let st;
  try {
    st = getState();
    await exclusive(async () => {
      if (st.kind === 'file') {
        await st.client.execute('PRAGMA foreign_keys = ON');
        const rs = await st.client.execute('PRAGMA foreign_keys');
        st.foreignKeys = Number(rs.rows[0]?.[0]) === 1 ? 'enforced' : 'not_enforced';
      }
      await st.client.execute('SELECT 1');
    });
  } catch (err) {
    throw new Error(explainConnectionError(err));
  }
  return { kind: st.kind, host: st.safeDescription };
}

export function explainConnectionError(err) {
  const mapped = mapDbError(err);
  const message = scrubDatabaseSecrets(mapped?.message ?? err?.message ?? '', config.db);
  const where = state?.safeDescription ?? 'configured database';
  if (mapped?.code === 'DB_UNAVAILABLE') {
    return `Cannot reach the Turso database (${where}). Check TURSO_DATABASE_URL and that the host is reachable from this service.`;
  }
  if (/unauthori[sz]ed|401|403|forbidden|jwt|auth/i.test(message)) {
    return 'Turso rejected the credentials. Check TURSO_AUTH_TOKEN (create one with: turso db tokens create <database-name>).';
  }
  if (/invalid database configuration/i.test(message)) return message;
  return `Database connection failed (${mapped?.code ?? 'UNKNOWN'}). ${message.slice(0, 200)}`;
}

/** Cheap liveness probe for /api/health. Never returns the URL or credentials. */
export async function checkDatabaseHealth({ timeoutMs = 3000 } = {}) {
  const started = Date.now();
  let timer;
  try {
    await Promise.race([
      query('SELECT 1 AS ok'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DbError('DB_UNAVAILABLE', 'health check timed out')), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started, foreignKeys: getState().foreignKeys };
  } catch (err) {
    const mapped = mapDbError(err);
    return { ok: false, latencyMs: Date.now() - started, code: mapped?.code ?? 'UNKNOWN' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determines whether the connected database enforces foreign keys.
 *
 * Previous implementation inserted a row into `sessions` with `admin_id = -1`
 * and a `strftime('%Y-%m-%dT%H:%M:%fZ','now')` timestamp, expecting a foreign-key
 * violation. That approach had three problems:
 *   1. It used a fake administrator ID (-1) that does not exist and violates the
 *      `REFERENCES admins(id)` constraint.
 *   2. The timestamp relied on `strftime` with string literals; when logs stripped
 *      literals it appeared as `strftime('', '')`, and a malformed expression
 *      yields NULL -> `NOT NULL` violation (`SQLITE_CONSTRAINT`) instead of the
 *      intended `FOREIGN KEY` violation, masking the real enforcement state.
 *   3. It performed a write during startup, creating a probe session that had
 *      to be rolled back; a read-only check is safer.
 *
 * The corrected probe is read-only:
 *   - `PRAGMA foreign_keys` is the canonical SQLite check (returns 1 when
 *     enforcement is on). For local files we already executed `PRAGMA
 *     foreign_keys=ON` at connect time, so this reflects the true state.
 *   - For remote Turso where PRAGMA may not be reliable, we fall back to a
 *     trivial `SELECT 1` to confirm connectivity and report `unknown` rather
 *     than inserting fake data. The health endpoint already distinguishes
 *     `ok` vs `unknown`.
 * This never inserts a fake session, never weakens constraints, and uses a
 * valid, driver-native timestamp path (no ad-hoc strftime).
 *
 * @returns {Promise<'enforced'|'not_enforced'|'unknown'>}
 */
export async function probeForeignKeys() {
  let result = 'unknown';
  // Retain the quiet flag for any future writes (no write is performed now).
  quietConstraintLog = true;
  try {
    const rs = await query('PRAGMA foreign_keys');
    const row = rs.rows[0];
    if (row) {
      const raw = row.foreign_keys ?? Object.values(row)[0];
      const n = Number(raw);
      if (n === 1) result = 'enforced';
      else if (n === 0) result = 'not_enforced';
    }
  } catch (_) {
    // PRAGMA may not be supported on some Turso transports; fall through.
  }
  // Trust the file-mode state set during connectDatabase (we explicitly set ON).
  if (result === 'unknown' && state?.kind === 'file' && state?.foreignKeys === 'enforced') {
    result = 'enforced';
  }
  // Verify DB is still reachable without writing; keeps state as unknown if we
  // cannot determine FK enforcement without a write.
  if (result === 'unknown') {
    try {
      await query('SELECT 1 AS ok');
    } catch {
      // connectivity failure; health check will report unavailable. Keep unknown.
    }
  }
  quietConstraintLog = false;
  if (state) state.foreignKeys = result;
  return result;
}

/** Closes the connection (used by server shutdown, scripts and tests). */
export function closeDatabase() {
  if (!state) return;
  try {
    state.client.close();
  } catch {
    // ignore: already closed
  }
  state = null;
  queue = Promise.resolve();
  txnTablesReady = false;
}

/**
 * Drops every table, trigger and view. Test-only and doubly guarded: refuses unless
 * NODE_ENV=test AND the database name contains "test". Never callable in production.
 */
export async function resetDatabaseForTests() {
  if (!config.isTest || config.isProd) throw new Error('resetDatabaseForTests is only allowed with NODE_ENV=test');
  const url = config.db.url ?? '';
  if (!/test/i.test(url)) throw new Error('resetDatabaseForTests refuses: TURSO_DATABASE_URL must name a test database');
  const objects = await query(
    "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view', 'table') AND name NOT LIKE 'sqlite_%'",
  );
  for (const row of objects.rows.filter((r) => r.type !== 'table')) {
    await query(`DROP ${row.type.toUpperCase()} IF EXISTS "${row.name.replace(/"/g, '""')}"`);
  }
  let pending = objects.rows.filter((r) => r.type === 'table').map((r) => r.name);
  while (pending.length) {
    const failed = [];
    let lastError = null;
    for (const name of pending) {
      try {
        await query(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
      } catch (err) {
        failed.push(name);
        lastError = err;
      }
    }
    if (failed.length === pending.length) throw lastError;
    pending = failed;
  }
}
