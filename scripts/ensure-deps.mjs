#!/usr/bin/env node
/**
 * ensure-deps.mjs
 * Ensures every dependency and devDependency declared across the root workspace,
 * `client`, and `server` is installed and matches `package-lock.json` before
 * `npm run build` executes.
 *
 * Why this is needed:
 *  1. Render services configured with `Build Command: npm run build` restore a
 *     cached `node_modules/` and invoke `npm run build` without running `npm ci`
 *     first. Any newly added or upgraded package (such as `tailwindcss`,
 *     `postcss`, `autoprefixer`) is missing from that stale cache.
 *  2. When `NODE_ENV=production` is set in the deployment environment, bare
 *     `npm ci` / `npm install` commands omit `devDependencies` unless
 *     `--include=dev` and `NPM_CONFIG_PRODUCTION=false` are explicitly passed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = ['', 'client', 'server'];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function findInstalledPackageJson(wsDir, pkgName, rootDir = ROOT) {
  const candidates = [
    join(wsDir, 'node_modules', pkgName, 'package.json'),
    join(rootDir, 'node_modules', pkgName, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Inspects declared dependencies + devDependencies across all workspaces and
 * returns an array of human-readable drift descriptions (empty when healthy).
 */
export function findDependencyDrift(rootDir = ROOT) {
  const lockPath = join(rootDir, 'package-lock.json');
  const lock = existsSync(lockPath) ? readJson(lockPath) : null;
  const lockPackages = lock?.packages ?? {};
  const issues = [];
  let checked = 0;

  for (const ws of WORKSPACES) {
    const wsDir = ws ? join(rootDir, ws) : rootDir;
    const manifestPath = join(wsDir, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = readJson(manifestPath);
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    const parentUrl = pathToFileURL(manifestPath).href;
    const label = ws || 'root';

    for (const pkgName of Object.keys(declared)) {
      checked += 1;
      const installedPkgPath = findInstalledPackageJson(wsDir, pkgName, rootDir);
      if (!installedPkgPath) {
        issues.push(`${label}: missing ${pkgName}`);
        continue;
      }

      let installedVersion;
      try {
        installedVersion = readJson(installedPkgPath).version;
      } catch {
        issues.push(`${label}: unreadable package.json for ${pkgName}`);
        continue;
      }

      const wsLockKey = ws ? `${ws}/node_modules/${pkgName}` : null;
      const lockedEntry =
        (wsLockKey && lockPackages[wsLockKey]) || lockPackages[`node_modules/${pkgName}`];
      if (lockedEntry?.version && installedVersion !== lockedEntry.version) {
        issues.push(
          `${label}: ${pkgName}@${installedVersion} does not match locked ${lockedEntry.version}`,
        );
        continue;
      }

      try {
        const entryUrl = import.meta.resolve(pkgName, parentUrl);
        if (!existsSync(fileURLToPath(entryUrl))) {
          issues.push(`${label}: entry file missing for ${pkgName}`);
        }
      } catch {
        issues.push(`${label}: cannot resolve entry point for ${pkgName}`);
      }
    }
  }

  return { issues, checked };
}

function runNpmInstall(args) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    ENSURE_DEPS_ACTIVE: '1',
  };
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_OMIT;
  delete env.npm_config_omit;
  return spawnSync(npmCmd, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
}

export function ensureDependencies(rootDir = ROOT) {
  if (process.env.ENSURE_DEPS_ACTIVE === '1') {
    return;
  }

  const initial = findDependencyDrift(rootDir);
  if (initial.issues.length === 0) {
    process.stdout.write(
      `[ensure-deps] OK: verified ${initial.checked} workspace dependencies\n`,
    );
    return;
  }

  process.stdout.write(
    `[ensure-deps] Detected ${initial.issues.length} missing/stale dependency entry(s):\n` +
      initial.issues.map((i) => `  - ${i}`).join('\n') +
      '\n[ensure-deps] Installing workspace dependencies (including devDependencies)...\n',
  );

  const hasLockfile = existsSync(join(rootDir, 'package-lock.json'));
  const primaryArgs = hasLockfile
    ? ['ci', '--include=dev', '--no-audit', '--no-fund']
    : ['install', '--include=dev', '--no-audit', '--no-fund'];

  let res = runNpmInstall(primaryArgs);
  if (res.status !== 0 && hasLockfile) {
    process.stdout.write(
      '[ensure-deps] `npm ci` exited non-zero; falling back to `npm install --include=dev`...\n',
    );
    res = runNpmInstall(['install', '--include=dev', '--no-audit', '--no-fund']);
  }

  if (res.status !== 0) {
    process.stderr.write(
      `[ensure-deps] FAIL: npm exited with status ${res.status ?? 'unknown'}\n`,
    );
    process.exit(res.status || 1);
  }

  const after = findDependencyDrift(rootDir);
  if (after.issues.length > 0) {
    process.stderr.write(
      `[ensure-deps] FAIL: dependencies still unresolved after install:\n` +
        after.issues.map((i) => `  - ${i}`).join('\n') +
        '\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `[ensure-deps] OK: installed and verified ${after.checked} workspace dependencies\n`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureDependencies(ROOT);
}
