#!/usr/bin/env node
/**
 * Development runner: `npm run dev`
 *   * starts the API with `node --watch --env-file=.env server/server.js`
 *   * starts Vite for the React SPA on :5173 with /api and /pay proxied to the API
 *   * restarts nothing else, needs no extra tool (no concurrently/nodemon)
 *
 * This is the ONLY place where two processes exist, and only in development.
 * Production is a single `node server` process.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url).replace(/\/scripts$/, ''));
const ENV_FILE = join(ROOT, '.env');

if (!existsSync(ENV_FILE)) {
  process.stderr.write(
    '\nMissing .env - copy .env.example to .env and fill it in:\n' +
      '  cp .env.example .env\n' +
      '  node -e "console.log(\'SESSION_SECRET=\'+require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n' +
      '  node -e "console.log(\'ENCRYPTION_KEY=\'+require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n\n',
  );
  process.exit(1);
}

const children = [];
function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, FORCE_COLOR: '1', ...(options.env ?? {}) },
  });
  child.on('exit', (code, signal) => {
    process.stdout.write(`\n[dev] ${name} exited (code=${code ?? 'null'} signal=${signal ?? 'none'})\n`);
    shutdown(code ?? 0);
  });
  children.push({ name, child });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write('[dev] starting API (node --watch) and Vite dev server...\n');
start('api', process.execPath, ['--watch', '--env-file=.env', 'server/server.js']);
start('vite', process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js')], { cwd: join(ROOT, 'client') });
