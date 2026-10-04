#!/usr/bin/env node
/**
 * Migration runner for environments where the Prisma CLI cannot reach
 * binaries.prisma.sh (air-gapped CI, restricted proxies, some sandboxes).
 *
 * It applies every migration.sql under prisma/migrations in lexicographic order and
 * records each one in the standard `_prisma_migrations` bookkeeping table with
 * the same id/checksum format the Prisma CLI uses, so a later
 * `prisma migrate deploy` (locally, in CI or on the VPS) sees the database as
 * fully migrated and does **not** re-apply anything.
 *
 * Usage:
 *   node scripts/apply-migrations.mjs                 # uses DATABASE_URL
 *   node scripts/apply-migrations.mjs --url <conn>    # explicit target
 *   node scripts/apply-migrations.mjs --database investor_portal_test
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

// ------------------------------------------------------------------- env ---
function loadEnvFile() {
  const file = path.join(serverRoot, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const envFile = loadEnvFile();
const argv = process.argv.slice(2);
const argValue = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

let connectionString =
  argValue('--url') ??
  (argValue('--database')
    ? null
    : process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? envFile.DIRECT_URL ?? envFile.DATABASE_URL);

if (!connectionString) {
  const base = process.env.DATABASE_URL ?? envFile.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/investor_portal';
  const url = new URL(base);
  url.pathname = `/${argValue('--database')}`;
  connectionString = url.toString();
}

// ---------------------------------------------------------- migrations -----
const migrationsDir = path.join(serverRoot, 'prisma', 'migrations');
const migrations = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const BOOKKEEPING_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum"            VARCHAR(64) NOT NULL,
  "finished_at"         TIMESTAMPTZ,
  "migration_name"      VARCHAR(255) NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      TIMESTAMPTZ,
  "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);`;

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query(BOOKKEEPING_DDL);

  const { rows } = await client.query(
    'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',
  );
  const applied = new Set(rows.map((row) => row.migration_name));

  let count = 0;
  for (const name of migrations) {
    if (applied.has(name)) {
      console.log(`[migrations] skip    ${name} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO "_prisma_migrations"
           ("id", "checksum", "finished_at", "migration_name", "logs", "started_at", "applied_steps_count")
         VALUES ($1, $2, now(), $3, $4, now(), 1)`,
        [crypto.randomUUID(), checksum, name, ''],
      );
      await client.query('COMMIT');
      console.log(`[migrations] applied ${name}`);
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[migrations] FAILED  ${name}`);
      throw error;
    }
  }
  console.log(
    count === 0
      ? '[migrations] database is up to date'
      : `[migrations] applied ${count} migration(s)`,
  );
} catch (error) {
  console.error('[migrations]', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
