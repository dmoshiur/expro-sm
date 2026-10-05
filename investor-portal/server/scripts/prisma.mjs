#!/usr/bin/env node
/**
 * Offline-friendly Prisma CLI launcher.
 *
 * Why this exists: `prisma generate` / `prisma validate` normally phone home to
 * binaries.prisma.sh to resolve a native *schema engine* binary - even though
 * Prisma 7 parses and validates schemas with the WASM build that is already
 * bundled inside the CLI. On air-gapped CI, restricted proxies and sandboxes
 * that CDN is blocked, and the CLI fails before doing any real work.
 *
 * This launcher keeps the exact same SQL, migration files and Prisma APIs, but:
 *   1. loads server/.env (Prisma 7 does not load .env on its own), and
 *   2. when no native engine binary is installed, points
 *      PRISMA_SCHEMA_ENGINE_BINARY at a stub file. Commands that only parse the
 *      schema - `generate`, `validate`, `format` - then run entirely on the
 *      WASM build with no network access.
 *
 * Commands that really have to talk to a database (`prisma migrate *`,
 * `prisma db *`, `prisma studio`) need the real engine and are therefore
 * provisioned differently in this project:
 *   - generate the SQL for a schema change with `prisma migrate diff --script`
 *     on a machine with engine downloads, or hand-write it, then
 *   - apply it with `npm run db:migrate` (scripts/apply-migrations.mjs), which
 *     speaks libSQL directly and works against both `file:` and `libsql://`.
 *
 * On a machine with working engine downloads everything behaves exactly like
 * the vanilla CLI (the stub is only applied when the binaries are missing).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');
const args = process.argv.slice(2);
const env = { ...process.env };

// ---------------------------------------------------------------- .env -----
const envFile = path.join(serverRoot, '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

// -------------------------------------------------- native engines? --------
function enginesDirCandidates() {
  return [
    path.join(repoRoot, 'node_modules', '@prisma', 'engines'),
    path.join(serverRoot, 'node_modules', '@prisma', 'engines'),
  ];
}

const SCHEMA_ENGINE_PREFIXES = ['schema-engine', 'migration-engine', 'libschema-engine'];

function hasNativeSchemaEngine() {
  return enginesDirCandidates().some((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .some((file) => SCHEMA_ENGINE_PREFIXES.some((prefix) => file.startsWith(prefix)));
    } catch {
      return false;
    }
  });
}

const schemaEngineFromEnv =
  env.PRISMA_SCHEMA_ENGINE_BINARY ?? env.PRISMA_MIGRATION_ENGINE_BINARY;

if (!hasNativeSchemaEngine() && !schemaEngineFromEnv) {
  const stubDir = path.join(os.tmpdir(), 'investor-portal-prisma-stub');
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'schema-engine');
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, 'prisma schema engine stub (WASM is used instead)\n');
  env.PRISMA_SCHEMA_ENGINE_BINARY = stub;
  process.stderr.write(
    '[prisma-launcher] native engines missing -> using the bundled WASM engine (generate/validate/format work offline)\n',
  );
}

// --------------------------------------------------------------- run -------
const prismaCli = require.resolve('prisma/build/index.js', { paths: [serverRoot, repoRoot] });
const result = spawnSync(process.execPath, [prismaCli, ...args], {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
});
process.exit(result.status ?? 1);
