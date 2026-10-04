#!/usr/bin/env node
/**
 * Offline-friendly Prisma CLI launcher.
 *
 * Why this exists: `prisma generate` / `prisma migrate` normally download
 * platform-specific Rust engines from binaries.prisma.sh at first use. On
 * air-gapped CI, some corporate networks and sandboxes that CDN is blocked.
 *
 * This launcher keeps the exact same SQL, migration files and Prisma APIs, but:
 *   1. loads server/.env (a prisma.config.ts is present, so Prisma itself no
 *      longer loads .env automatically), and
 *   2. when the native engines are NOT installed, points the generator at a
 *      stub library and enables the JavaScript/WASM schema engine. The client is
 *      generated with `engineType = "client"`: queries are executed by the WASM
 *      query compiler through the node-postgres driver adapter, so the native
 *      library is never opened at runtime.
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

function hasNativeEngines() {
  const prefixes = ['libquery_engine', 'query-engine', 'schema-engine'];
  return enginesDirCandidates().some((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
    } catch {
      return false;
    }
  });
}

if (!hasNativeEngines()) {
  const stubDir = path.join(os.tmpdir(), 'investor-portal-prisma-stub');
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'libquery_engine.so.node');
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, 'prisma engine stub (unused: engineType=client)\n');
  env.PRISMA_QUERY_ENGINE_LIBRARY = env.PRISMA_QUERY_ENGINE_LIBRARY ?? stub;
  env.PRISMA_ENGINE = env.PRISMA_ENGINE ?? 'js';
  process.stderr.write('[prisma-launcher] native engines missing -> using WASM schema engine + engineType=client\n');
}

// --------------------------------------------------------------- run -------
const prismaCli = require.resolve('prisma/build/index.js', { paths: [serverRoot, repoRoot] });
const result = spawnSync(process.execPath, [prismaCli, ...args], {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
});
process.exit(result.status ?? 1);
