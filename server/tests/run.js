#!/usr/bin/env node
/**
 * Test runner: `node --test` from the repository root.
 *
 * Runs each test module in its own process (sequentially, so they can share one
 * disposable test database without stepping on each other) and prints a compact
 * summary. Usage: `npm test` (add `--filter payments` to run matching files).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
const files = readdirSync(HERE)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !filter || name.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`No test files matched "${filter}"`);
  process.exit(1);
}

const results = [];
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  // eslint-disable-next-line no-await-in-loop
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', join(HERE, file)], {
      stdio: 'inherit',
      cwd: dirname(HERE),
      env: { ...process.env, NODE_ENV: 'test' },
    });
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  results.push({ file, code });
}

const failed = results.filter((result) => result.code !== 0);
console.log('\n──────────────────────────────────────────────');
for (const result of results) {
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.file}`);
}
console.log('──────────────────────────────────────────────');
console.log(`${results.length - failed.length}/${results.length} test files passed`);
process.exit(failed.length === 0 ? 0 : 1);
