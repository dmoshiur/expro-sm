#!/usr/bin/env node
/**
 * Turso/libSQL logical backup (`npm run db:backup`).
 *
 * Writes a portable SQL script (schema + data) that can be restored with
 * `turso db shell <db> < backup.sql` or `node scripts/apply-backup.mjs`.
 * Works against a local `file:` database and a remote `libsql://` one, so it
 * doubles as the nightly cron job and as the pre-migration safety net.
 *
 *   node scripts/turso-backup.mjs                       # -> backups/turso-<date>.sql
 *   node scripts/turso-backup.mjs --out /var/backups/x.sql
 *   node scripts/turso-backup.mjs --data-only
 *
 * For a byte-exact physical copy of a remote database prefer `turso db dump`
 * (server-side, no round trips); this script is the dependency-free fallback
 * and the only option for an embedded replica file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

function loadEnvFile() {
  const file = path.join(serverRoot, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        let value = line.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [line.slice(0, index).trim(), value];
      }),
  );
}

const envFile = loadEnvFile();
const argv = process.argv.slice(2);
const argValue = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const url =
  argValue('--url') ??
  process.env.TURSO_DATABASE_URL ??
  process.env.DATABASE_URL ??
  envFile.TURSO_DATABASE_URL ??
  envFile.DATABASE_URL ??
  'file:./prisma/dev.db';
const authToken = argValue('--auth-token') ?? process.env.TURSO_AUTH_TOKEN ?? envFile.TURSO_AUTH_TOKEN;
const dataOnly = argv.includes('--data-only');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = argValue('--out') ?? path.join(serverRoot, 'backups', `turso-${stamp}.sql`);

const escape = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `X'${Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('hex')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

const client = createClient({ url, ...(authToken ? { authToken } : {}) });
const chunks = [];
let rowCount = 0;

try {
  const objects = await client.execute(
    `SELECT "type", "name", "sql" FROM "sqlite_master"
      WHERE "sql" IS NOT NULL AND "name" NOT LIKE 'sqlite_%'
      ORDER BY CASE "type" WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, "name"`,
  );

  chunks.push(`-- Turso/libSQL backup of ${url}`, `-- generated at ${new Date().toISOString()}`, 'PRAGMA foreign_keys = OFF;', 'BEGIN;', '');

  const tables = objects.rows.filter((row) => row.type === 'table');

  if (!dataOnly) {
    for (const row of objects.rows) {
      if (row.type === 'table' && String(row.name) === '_prisma_migrations') continue;
      chunks.push(`${String(row.sql)};`);
    }
    chunks.push('');
  }

  for (const table of tables) {
    const name = String(table.name);
    const { rows } = await client.execute(`SELECT * FROM "${name}"`);
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    chunks.push(`-- ${name}: ${rows.length} row(s)`);
    for (const row of rows) {
      chunks.push(
        `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns
          .map((column) => escape(row[column]))
          .join(', ')});`,
      );
      rowCount += 1;
    }
    chunks.push('');
  }

  chunks.push('COMMIT;', 'PRAGMA foreign_keys = ON;', '');

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const body = chunks.join('\n');
  fs.writeFileSync(outFile, body, { mode: 0o600 });
  console.log(`[backup] wrote ${outFile} (${rowCount} rows, ${(body.length / 1024).toFixed(1)} KiB) from ${url}`);
} catch (error) {
  console.error('[backup]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.close();
}
