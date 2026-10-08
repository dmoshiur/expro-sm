#!/usr/bin/env node
/** Preflight check: `npm run check` - validates env + database reachability. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = join(ROOT, '.env');

if (!existsSync(envFile)) {
  process.stderr.write('.env not found - copy .env.example to .env first.\n');
  process.exit(1);
}

// Minimal .env parser (no dotenv dependency); node --env-file does this for the server.
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!match) continue;
  const [, key, rawValue] = match;
  let value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (process.env[key] === undefined) process.env[key] = value;
}

const { validateConfig, config } = await import(join(ROOT, 'server/src/config/index.js'));
const problems = validateConfig(config);
if (problems.length) {
  process.stderr.write(`Configuration problems:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Configuration OK.\n');

const { query, closePool } = await import(join(ROOT, 'server/src/db/pool.js'));
try {
  const res = await query('select current_database() as db, version() as version');
  process.stdout.write(`Database reachable: ${res.rows[0].db}\n`);
  const migrations = await query(`select count(*)::int as count from schema_migrations`).catch(() => ({ rows: [{ count: 0 }] }));
  process.stdout.write(`Migrations applied: ${migrations.rows[0].count} (run \`npm run migrate\` if this is lower than expected)\n`);
} catch (err) {
  process.stderr.write(`Database check failed: ${err.message}\n`);
  await closePool().catch(() => {});
  process.exit(1);
}
await closePool();
