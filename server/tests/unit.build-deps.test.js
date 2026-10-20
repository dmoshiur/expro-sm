import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDependencyDrift } from '../../scripts/ensure-deps.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('build dependency guard & Tailwind/PostCSS production build', () => {
  it('verifies all workspace dependencies match package-lock.json when installed', () => {
    const result = findDependencyDrift(ROOT);
    assert.deepEqual(result.issues, []);
    assert.ok(result.checked >= 15);
  });

  it('detects missing packages and stale lockfile versions in a cached node_modules tree', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ensure-deps-test-'));
    try {
      mkdirSync(join(fixture, 'client'), { recursive: true });
      mkdirSync(join(fixture, 'node_modules/vite'), { recursive: true });

      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['client'], devDependencies: { vite: '^5.4.11' } }),
      );
      writeFileSync(
        join(fixture, 'client/package.json'),
        JSON.stringify({
          name: 'client',
          devDependencies: { tailwindcss: '^3.4.19', postcss: '^8.5.31', vite: '^5.4.11' },
        }),
      );
      writeFileSync(
        join(fixture, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/vite': { version: '5.4.21' },
            'node_modules/tailwindcss': { version: '3.4.19' },
            'node_modules/postcss': { version: '8.5.31' },
          },
        }),
      );
      // Simulate stale cache: old vite version and missing tailwindcss/postcss
      writeFileSync(
        join(fixture, 'node_modules/vite/package.json'),
        JSON.stringify({ name: 'vite', version: '5.4.11', main: 'index.js' }),
      );
      writeFileSync(join(fixture, 'node_modules/vite/index.js'), 'export {};\n');

      const { issues } = findDependencyDrift(fixture);
      assert.ok(issues.some((i) => i.includes('client: missing tailwindcss')));
      assert.ok(issues.some((i) => i.includes('client: missing postcss')));
      assert.ok(issues.some((i) => i.includes('vite@5.4.11 does not match locked 5.4.21')));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('self-heals missing tailwindcss when `npm run build` runs directly with NODE_ENV=production', () => {
    // Reproduce the exact Render failure: cached node_modules without tailwindcss/postcss/autoprefixer
    // and Build Command = `npm run build` under NODE_ENV=production.
    for (const pkg of ['tailwindcss', 'postcss', 'autoprefixer']) {
      rmSync(join(ROOT, 'node_modules', pkg), { recursive: true, force: true });
      rmSync(join(ROOT, 'client/node_modules', pkg), { recursive: true, force: true });
    }
    assert.equal(existsSync(join(ROOT, 'node_modules/tailwindcss/package.json')), false);

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const output = execFileSync(npmCmd, ['run', 'build'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
    });

    assert.match(output, /\[ensure-deps\] Detected .*missing\/stale dependency/);
    assert.match(output, /\[ensure-deps\] OK: installed and verified/);
    assert.match(output, /\[verify-build\] OK:/);
    assert.equal(existsSync(join(ROOT, 'node_modules/tailwindcss/package.json')), true);

    const assetsDir = join(ROOT, 'client/dist/assets');
    const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
    assert.ok(cssFiles.length >= 1, 'expected compiled CSS asset in client/dist/assets');
    const compiledCss = readFileSync(join(assetsDir, cssFiles[0]), 'utf8');
    assert.equal(compiledCss.includes('@tailwind '), false, 'expected @tailwind directives to be compiled');
    assert.ok(compiledCss.includes('.bg-brand-gradient'), 'expected custom Tailwind theme utility in CSS bundle');
  });
});
