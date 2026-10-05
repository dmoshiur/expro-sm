#!/usr/bin/env node
/**
 * Drops every table in the target libSQL/Turso database and re-applies every
 * migration from scratch. Local development, CI and the test suite only.
 *
 *   node scripts/reset-db.mjs                       # TURSO_DATABASE_URL / DATABASE_URL
 *   node scripts/reset-db.mjs --test                # TEST_DATABASE_URL (default file:./prisma/test.db)
 *   node scripts/reset-db.mjs --url file:./prisma/dev.db
 *   node scripts/reset-db.mjs --database investor_portal_test   # legacy flag -> file:./prisma/<name>.db
 *
 * Refuses to touch a remote database unless --force is passed, and refuses to
 * touch a database whose URL does not look like a throwaway (its name must
 * contain `test`, `dev`, `local` or `tmp`) unless --force is passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

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
const wantsTest = argv.includes('--test');
const force = argv.includes('--force');
const databaseArg = argValue('--database');

const url =
  argValue('--url') ??
  (databaseArg ? `file:./prisma/${databaseArg}.db` : undefined) ??
  (wantsTest
    ? process.env.TEST_DATABASE_URL ?? envFile.TEST_DATABASE_URL ?? 'file:./prisma/test.db'
    : process.env.TURSO_DATABASE_URL ??
      process.env.DATABASE_URL ??
      envFile.TURSO_DATABASE_URL ??
      envFile.DATABASE_URL ??
      'file:./prisma/dev.db');
const authToken = argValue('--auth-token') ?? process.env.TURSO_AUTH_TOKEN ?? envFile.TURSO_AUTH_TOKEN;

const isFile = url.startsWith('file:');
const looksThrowaway = /(test|dev|local|tmp|scratch)/i.test(url);

if (!isFile && !force) {
  console.error(`[reset] refusing to reset the remote database ${url}. Pass --force if you really mean it.`);
  process.exit(1);
}
if (!looksThrowaway && !force) {
  console.error(`[reset] "${url}" does not look like a development/test database. Pass --force to override.`);
  process.exit(1);
}

const TABLES = [
  'audit_logs',
  'sms_logs',
  'payments',
  'installments',
  'investments',
  'nominees',
  'investors',
  'refresh_tokens',
  'admins',
  'settings',
  '_prisma_migrations',
];

const client = createClient({ url, ...(authToken ? { authToken } : {}) });
try {
  await client.execute('PRAGMA foreign_keys = OFF');
  for (const table of TABLES) {
    await client.execute(`DROP TABLE IF EXISTS "${table}"`);
  }
  await client.execute('PRAGMA foreign_keys = ON');
  console.log(`[reset] dropped ${TABLES.length} table(s) on ${url}`);
} catch (error) {
  console.error('[reset]', error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  client.close();
}

const result = spawnSync(process.execPath, [path.join(here, 'apply-migrations.mjs'), '--url', url, ...(authToken ? ['--auth-token', authToken] : [])], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
