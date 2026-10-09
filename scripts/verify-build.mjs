#!/usr/bin/env node
/**
 * verify-build.mjs
 * Fail the build with a clear error if required frontend assets are missing,
 * rather than silently deploying an unusable application.
 *
 * Checks:
 *  - client/dist/index.html exists
 *  - client/dist/assets contains at least one JS and one CSS chunk
 *  - index.html references the built assets and favicon
 *
 * Exit 0 when all checks pass, 1 otherwise. Used by `npm run build` and by
 * `scripts/verify-deploy.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'client/dist');
const INDEX = join(DIST, 'index.html');
const ASSETS = join(DIST, 'assets');

function fail(msg) {
  process.stderr.write(`\n[verify-build] FAIL: ${msg}\n`);
  process.stderr.write(`Expected dist at: ${DIST}\n`);
  process.stderr.write(`HINT: run \`npm run build\` (requires Node >=22.9 and dev deps: vite, @vitejs/plugin-react)\n`);
  process.stderr.write(`If building on Render, ensure Build Command is:\n`);
  process.stderr.write(`  npm ci && npm run build\n`);
  process.stderr.write(`and that NODE_ENV does not hide devDependencies before the build step.\n\n`);
  process.exit(1);
}

if (!existsSync(INDEX)) {
  fail('client/dist/index.html is missing – frontend was not built');
}

let assets = [];
try { assets = readdirSync(ASSETS); } catch { fail('client/dist/assets directory is missing'); }

const js = assets.filter(f => f.endsWith('.js'));
const css = assets.filter(f => f.endsWith('.css'));
if (js.length === 0) fail('No JavaScript chunks found in client/dist/assets');
if (css.length === 0) fail('No CSS chunks found in client/dist/assets');

const html = readFileSync(INDEX, 'utf8');
if (!html.includes('/assets/')) fail('index.html does not reference /assets/ – unexpected Vite output');
if (!html.includes('Investor Installment Portal')) fail('index.html title missing');

const faviconIco = join(DIST, 'favicon.ico');
const faviconSvg = join(DIST, 'favicon.svg');
if (!existsSync(faviconIco)) {
  // Favicons are not strictly required for the build to succeed, but warn clearly.
  process.stdout.write('[verify-build] WARN: favicon.ico missing in dist – /favicon.ico will return 404\n');
}
if (!existsSync(faviconSvg)) {
  process.stdout.write('[verify-build] WARN: favicon.svg missing in dist\n');
}

const stat = readdirSync(DIST);
process.stdout.write(`[verify-build] OK: ${DIST} exists\n`);
process.stdout.write(`  index.html: ${(readFileSync(INDEX).length/1024).toFixed(1)} kB\n`);
process.stdout.write(`  assets: ${js.join(', ')} ; ${css.join(', ')}\n`);
process.stdout.write(`  files in dist: ${stat.join(', ')}\n`);
