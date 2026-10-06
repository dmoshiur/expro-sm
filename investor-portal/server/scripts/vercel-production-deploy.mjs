#!/usr/bin/env node
/**
 * Production-only deployment tasks for Vercel.
 *
 * Vercel's server service runs this after compiling the API. Preview builds and
 * local builds are deliberately read-only: only a production build with hosted
 * Turso credentials may apply migrations or initialize the first admin.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');

if (process.env.VERCEL_ENV !== 'production') {
  console.log(`[vercel] Skipping production database setup (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}).`);
  process.exit(0);
}

const databaseUrl = [process.env.TURSO_DATABASE_URL, process.env.DATABASE_URL]
  .map((value) => value?.trim())
  .find((value) => Boolean(value));
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

if (!databaseUrl || !/^(?:libsql|https):\/\//i.test(databaseUrl)) {
  console.error('[vercel] Production deployment requires TURSO_DATABASE_URL to point to hosted Turso/libSQL.');
  process.exit(1);
}
if (!authToken) {
  console.error('[vercel] Production deployment requires TURSO_AUTH_TOKEN to apply database migrations.');
  process.exit(1);
}

function run(command, args, label) {
  console.log(`[vercel] ${label}`);
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[vercel] Could not ${label.toLowerCase()}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Fail the production build rather than deploying an API whose DB schema is
// missing. Migrations are versioned, repeatable and run before the new function
// receives traffic; production migrations should remain backward-compatible.
run(process.execPath, [path.join(here, 'apply-migrations.mjs')], 'Applying pending production database migrations');

// Idempotent: creates the first super admin and default settings on a fresh DB,
// then leaves existing credentials/data unchanged on subsequent deployments.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(npm, ['--workspace', 'server', 'run', 'seed'], 'Ensuring the initial production admin and default settings');
