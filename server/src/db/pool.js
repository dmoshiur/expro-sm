/**
 * PostgreSQL pool. Single shared Pool for the whole process (no extra server,
 * no ORM). BIGINT columns (poisha) are parsed to JS numbers, and `numeric`
 * (used only for percentages) to Number as well.
 */
import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError, fromPgError } from '../utils/errors.js';

const { Pool, types } = pg;

// int8 / bigint -> number (poisha amounts, ids)
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
// numeric -> number (share_percent)
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));
// date -> keep the plain 'YYYY-MM-DD' string. Date columns are business dates in
// Asia/Dhaka, never instants: turning them into JS Date objects would silently
// shift them across timezones and break comparisons.
types.setTypeParser(1082, (value) => value);

let pool = null;

export function getPool() {
  if (!pool) {
    if (!config.db.url) throw new AppError(500, 'CONFIG', 'DATABASE_URL is not configured');
    pool = new Pool({
      connectionString: config.db.url,
      max: config.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : undefined,
      application_name: 'investor-portal',
      statement_timeout: config.db.statementTimeoutMs,
    });
    pool.on('error', (err) => logger.error('postgres pool error on idle client', { err }));
    logger.info('postgres pool created', { ssl: config.db.ssl, max: config.db.poolMax, host: hostOf(config.db.url) });
  }
  return pool;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

export async function query(text, params = [], client = undefined) {
  const executor = client ?? getPool();
  const started = Date.now();
  try {
    const res = await executor.query(text, params);
    const durationMs = Date.now() - started;
    if (durationMs > 500 && !config.isTest) {
      logger.warn('slow query', { durationMs, rows: res.rowCount, sql: firstLine(text) });
    }
    return res;
  } catch (err) {
    logger.error('query failed', { err, sql: firstLine(text), code: err?.code });
    throw fromPgError(err);
  }
}

function firstLine(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Run `fn(client)` inside a transaction. Commits on success, rolls back on any
 * error and re-throws. Nested calls reuse the same client (savepoint-free:
 * services are written to take part in the caller's transaction).
 */
export async function withTransaction(fn, { isolationLevel } = {}) {
  const client = await getPool().connect();
  try {
    await client.query(isolationLevel ? `BEGIN ISOLATION LEVEL ${isolationLevel}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('rollback failed', { err: rollbackErr });
    }
    if (err instanceof AppError || err?.status) throw err;
    logger.error('transaction failed', { err });
    throw fromPgError(err);
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  const res = await query('select 1 as ok, now() as now');
  return { ok: res.rows[0]?.ok === 1, now: res.rows[0]?.now };
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
    logger.info('postgres pool closed');
  }
}

/** Test helper: allows pointing the pool at another database. */
export function resetPoolForTests() {
  pool = null;
}
export const __pool = { get value() { return pool; } };
