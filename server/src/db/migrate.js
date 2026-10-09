/**
 * Migration runner for Turso (libSQL). Applies numbered .sql files in order.
 * Each file runs in its own transaction together with its schema_migrations row,
 * so a failed file leaves no partial changes. Already-applied files are skipped;
 * an applied file that changed on disk is refused (checksum drift guard).
 *
 * This runner is additive only. It never drops or resets data. Destructive
 * resets exist only in test helpers (client.resetDatabaseForTests).
 *
 * Usage (explicit, recommended for production):
 *   npm run migrate                       # apply pending migrations
 *   node server/src/db/migrate.js --dry-run   # list what would be applied
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDatabase, connectDatabase } from './client.js';
import { splitSqlStatements, NOW } from './sql.js';
import { logger } from '../utils/logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');

const METADATA_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (${NOW}),
  duration_ms INTEGER NOT NULL DEFAULT 0
)`;

async function metadataExists() {
  const res = await query("SELECT type FROM sqlite_master WHERE name = 'schema_migrations'");
  if (res.rows[0] && res.rows[0].type !== 'table') {
    throw new Error('Incompatible schema_migrations: expected a table. No automatic repair is safe; operator review required.');
  }
  return res.rows.length > 0;
}

async function validateMetadata() {
  const { rows } = await query("PRAGMA table_info('schema_migrations')");
  const columns = new Map(rows.map((r) => [r.name, r]));
  const invalid = ['filename', 'checksum', 'applied_at', 'duration_ms'].filter((name) => {
    const c = columns.get(name);
    return !c || c.type.toUpperCase() !== (name === 'duration_ms' ? 'INTEGER' : 'TEXT') ||
      (name === 'filename' ? c.pk !== 1 : c.notnull !== 1) ||
      (name === 'applied_at' && !c.dflt_value);
  });
  if (invalid.length) {
    throw new Error(`Incompatible schema_migrations columns: ${invalid.join(', ')}. ` +
      'No metadata or application records were repaired. Operator review is required.');
  }
}

async function refuseUntrackedSchema() {
  // A schema without history must not be guessed/baselined or overwritten.
  const { rows } = await query(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('admins', 'sessions', 'investors', 'nominees', 'investments',
      'installments', 'payments', 'audit_logs', 'sms_logs', 'job_runs')`);
  if (rows.length) {
    throw new Error('SCHEMA_WITHOUT_HISTORY: application tables exist without migration history. ' +
      'Refusing to replay the initial schema or mark it applied. Operator schema/history review is required; existing data is unchanged.');
  }
}

async function ensureMigrationsTable() {
  if (!(await metadataExists())) await refuseUntrackedSchema();
  await query(METADATA_DDL);
  await validateMetadata();
}

export async function listMigrationFiles({ migrationsDir = MIGRATIONS_DIR } = {}) {
  const entries = await readdir(migrationsDir);
  return entries.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en'));
}

export async function appliedMigrations({ readOnly = false } = {}) {
  if (readOnly) {
    if (!(await metadataExists())) {
      await refuseUntrackedSchema();
      return [];
    }
    await validateMetadata();
  } else {
    await ensureMigrationsTable();
  }
  const res = await query('SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename');
  return res.rows;
}

/**
 * Applies pending migrations. Returns { applied: string[], skipped: string[], pending: string[] }.
 * Throws when an already-applied file changed on disk.
 */
export async function runMigrations({ dryRun = false, log = logger, migrationsDir = MIGRATIONS_DIR } = {}) {
  const history = await appliedMigrations({ readOnly: dryRun });
  if (!history.length) await refuseUntrackedSchema();
  const files = await listMigrationFiles({ migrationsDir });
  const done = new Map(history.map((r) => [r.filename, r.checksum]));
  const applied = [];
  const skipped = [];
  const pending = [];

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (done.has(file)) {
      if (done.get(file) !== checksum) {
        throw new Error(
          `Migration ${file} was modified after it was applied (checksum mismatch). ` +
            'Add a new migration file instead of editing an applied one.',
        );
      }
      skipped.push(file);
      continue;
    }
    pending.push(file);
    if (dryRun) continue;

    const started = Date.now();
    const statements = splitSqlStatements(sql);
    try {
      const executed = await withTransaction(async (tx) => {
        // Re-check inside the transaction in case another process applied it meanwhile.
        const again = await tx.query('SELECT checksum FROM schema_migrations WHERE filename = ?1', [file]);
        if (again.rows[0]) {
          if (again.rows[0].checksum !== checksum) {
            throw new Error(`Migration ${file} was modified after it was applied (checksum mismatch).`);
          }
          return false;
        }
        for (const statement of statements) {
          await tx.query(statement);
        }
        await tx.query('INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES (?1, ?2, ?3)', [
          file,
          checksum,
          Date.now() - started,
        ]);
        return true;
      });
      if (!executed) {
        skipped.push(file);
        continue;
      }
    } catch (err) {
      throw new Error(
        `Migration ${file} failed and was rolled back (no partial changes applied): ${err?.message ?? err}`,
        { cause: err },
      );
    }
    applied.push(file);
    log.info('migration applied', { file, durationMs: Date.now() - started, statements: statements.length });
  }

  return { applied, skipped, pending: dryRun ? pending : [] };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const target = await connectDatabase();
    logger.info('migrating database', { target: target.host, kind: target.kind, dryRun });
    const result = await runMigrations({ dryRun });
    logger.info('migrations complete', {
      applied: result.applied.length,
      skipped: result.skipped.length,
      dryRun,
      files: dryRun ? result.pending : result.applied,
    });
    closeDatabase();
    process.exit(0);
  } catch (err) {
    logger.error('migration failed', { err });
    closeDatabase();
    process.exit(1);
  }
}
