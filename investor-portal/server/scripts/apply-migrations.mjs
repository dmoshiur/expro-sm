#!/usr/bin/env node
/**
 * libSQL/Turso migration runner.
 *
 * Why this exists: the Prisma CLI's schema engine cannot dial a remote
 * `libsql://` URL (the documented Turso workflow is `prisma migrate diff` to
 * generate SQL, then `turso db shell` to apply it), and in restricted networks
 * it cannot even download its native engine binary. This runner applies the
 * same `prisma/migrations/<name>/migration.sql` files through `@libsql/client`, so
 * one command works for a local SQLite file and for a remote Turso database:
 *
 *   node scripts/apply-migrations.mjs                     # TURSO_DATABASE_URL / DATABASE_URL
 *   node scripts/apply-migrations.mjs --url libsql://... --auth-token <token>
 *   node scripts/apply-migrations.mjs --url file:./prisma/dev.db
 *   node scripts/apply-migrations.mjs --status            # only report
 *
 * Bookkeeping uses the standard `_prisma_migrations` table with the same
 * id/checksum format as the Prisma CLI, so a later `prisma migrate deploy`
 * (from a machine with engine downloads) sees the database as fully migrated
 * and does not re-apply anything.
 *
 * Each migration runs inside a transaction; SQLite DDL is transactional, so a
 * failed migration leaves the database untouched.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

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

const statusOnly = argv.includes('--status');
const databaseArg = argValue('--database'); // legacy flag: treated as a local file name
const url =
  argValue('--url') ??
  (databaseArg ? `file:./prisma/${databaseArg}.db` : undefined) ??
  process.env.TURSO_DATABASE_URL ??
  process.env.DATABASE_URL ??
  envFile.TURSO_DATABASE_URL ??
  envFile.DATABASE_URL ??
  'file:./prisma/dev.db';
const authToken =
  argValue('--auth-token') ??
  process.env.TURSO_AUTH_TOKEN ??
  envFile.TURSO_AUTH_TOKEN;

if (!url.startsWith('file:') && !authToken) {
  console.error('[migrations] TURSO_AUTH_TOKEN is required for a remote database (or pass --auth-token)');
  process.exit(1);
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
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "checksum"            TEXT NOT NULL,
  "finished_at"         DATETIME,
  "migration_name"      TEXT NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      DATETIME,
  "started_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);`;

const client = createClient({ url, ...(authToken ? { authToken } : {}) });

try {
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(BOOKKEEPING_DDL);

  const { rows } = await client.execute(
    'SELECT "migration_name", "checksum" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',
  );
  const applied = new Map(rows.map((row) => [String(row.migration_name), String(row.checksum)]));

  if (statusOnly) {
    console.log(`[migrations] database: ${url}`);
    for (const name of migrations) {
      console.log(`  ${applied.has(name) ? 'applied ' : 'pending '} ${name}`);
    }
    if (applied.size === 0) console.log('  (no migration has been applied yet)');
  } else {
    let count = 0;
    for (const name of migrations) {
      if (applied.has(name)) {
        console.log(`[migrations] skip    ${name} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const bookkeeping = `INSERT INTO "_prisma_migrations"
           ("id", "checksum", "finished_at", "migration_name", "logs", "started_at", "applied_steps_count")
         VALUES ('${crypto.randomUUID()}', '${checksum}', CURRENT_TIMESTAMP, '${name.replace(/'/g, "''")}', '', CURRENT_TIMESTAMP, 1);`;

      try {
        // executeMultiple understands trigger BEGIN...END blocks (a naive split
        // on ';' would not) and runs the explicit BEGIN/COMMIT as one unit.
        await client.executeMultiple(`BEGIN;\n${sql}\n${bookkeeping}\nCOMMIT;`);
        console.log(`[migrations] applied ${name}`);
        count += 1;
      } catch (error) {
        await client.execute('ROLLBACK').catch(() => undefined);
        console.error(`[migrations] FAILED  ${name}`);
        throw error;
      }
    }
    console.log(
      count === 0
        ? '[migrations] database is up to date'
        : `[migrations] applied ${count} migration(s)`,
    );
  }
} catch (error) {
  console.error('[migrations]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.close();
}
