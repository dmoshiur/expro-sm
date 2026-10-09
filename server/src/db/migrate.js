/**
 * Tiny migration runner: applies plain numbered .sql files in order inside a
 * transaction each, recording them in `schema_migrations`. Idempotent - safe to
 * run on every deploy (and after a restart).
 *
 * Usage: npm run migrate        (or: node server/src/db/migrate.js --dry-run)
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getPool, query, withTransaction, closePool } from './pool.js';
import { logger } from '../utils/logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');

async function ensureMigrationsTable() {
  await query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer not null default 0
    )
  `);
}

export async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en'));
}

export async function appliedMigrations() {
  const res = await query('select filename, checksum, applied_at from schema_migrations order by filename');
  return res.rows;
}

/**
 * Applies pending migrations. Returns { applied: string[], skipped: string[] }.
 * Throws when an already-applied file changed on disk (drift guard).
 */
export async function runMigrations({ dryRun = false, log = logger } = {}) {
  await ensureMigrationsTable();
  const files = await listMigrationFiles();
  const done = new Map((await appliedMigrations()).map((r) => [r.filename, r.checksum]));
  const applied = [];
  const skipped = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (done.has(file)) {
      if (done.get(file) !== checksum) {
        throw new Error(
          `Migration ${file} was modified after it was applied (checksum mismatch). ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      skipped.push(file);
      continue;
    }
    if (dryRun) {
      applied.push(file);
      continue;
    }
    const started = Date.now();
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('insert into schema_migrations (filename, checksum, duration_ms) values ($1, $2, $3)', [
        file,
        checksum,
        Date.now() - started,
      ]);
    });
    const durationMs = Date.now() - started;
    applied.push(file);
    log.info('migration applied', { file, durationMs });
  }

  return { applied, skipped };
}

/** Test helper: drop every object in the public schema (fresh DB each run). */
export async function resetDatabase() {
  await query('drop schema if exists public cascade; create schema public;');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    getPool();
    const result = await runMigrations({ dryRun });
    logger.info('migrations complete', {
      applied: result.applied.length,
      skipped: result.skipped.length,
      dryRun,
      files: result.applied,
    });
    await closePool();
    process.exit(0);
  } catch (err) {
    logger.error('migration failed', { err });
    await closePool().catch(() => {});
    process.exit(1);
  }
}
