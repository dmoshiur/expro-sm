#!/usr/bin/env node
/**
 * Drops the `public` schema of the target database and re-applies every
 * migration from scratch. Local development / CI only.
 *
 *   node scripts/reset-db.mjs                    # DATABASE_URL
 *   node scripts/reset-db.mjs --database investor_portal_test
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const readEnv = () => {
  const file = path.join(serverRoot, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        let v = l.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return [l.slice(0, i).trim(), v];
      }),
  );
};

const envFile = readEnv();
const argv = process.argv.slice(2);
const dbArgIndex = argv.indexOf('--database');
const base =
  process.env.DATABASE_URL ?? envFile.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/investor_portal';
const url = new URL(base);
if (dbArgIndex !== -1) url.pathname = `/${argv[dbArgIndex + 1]}`;

const client = new Client({ connectionString: url.toString() });
await client.connect();
await client.query('DROP SCHEMA IF EXISTS "public" CASCADE');
await client.query('CREATE SCHEMA "public"');
await client.end();
console.log(`[reset] schema public recreated on ${url.pathname.slice(1)}`);

const result = spawnSync(process.execPath, [path.join(here, 'apply-migrations.mjs'), '--url', url.toString()], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
