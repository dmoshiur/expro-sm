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

const { runDbCheck } = await import(join(ROOT, 'server/src/db/check.js'));
const { closeDatabase } = await import(join(ROOT, 'server/src/db/client.js'));
try {
  await runDbCheck();
} catch (err) {
  process.stderr.write(`Database check failed: ${err.message}\n`);
  closeDatabase();
  process.exit(1);
}
closeDatabase();
