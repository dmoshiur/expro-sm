#!/usr/bin/env node
/**
 * Zero-configuration local bootstrap.
 *
 *   npm run setup                 # create server/.env + client/.env, migrate, seed
 *   npm run setup -- --force      # regenerate the env files (keeps existing secrets? no: rewrites)
 *   npm run setup -- --skip-db    # only write the env files
 *   npm run setup -- --password 'MyPassword123'   # choose the first super-admin password
 *
 * What it does:
 *   1. writes `server/.env` (from `server/.env.example`, with local SQLite, freshly
 *      generated secrets and a working seed login) and `client/.env`;
 *   2. applies the Prisma/libSQL migrations to the local database file;
 *   3. seeds the first SUPER_ADMIN plus the default settings.
 *
 * No external accounts are required: the console SMS provider, local file
 * storage and the mock bKash gateway are used until real credentials are added
 * to `server/.env`. Existing `.env` files are never overwritten unless --force
 * is passed, so running it again is safe.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const portalRoot = path.resolve(here, '..');
const serverRoot = path.join(portalRoot, 'server');

// --------------------------------------------------------------- args ------
const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const flagValue = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const force = hasFlag('--force');
const skipDb = hasFlag('--skip-db');
const requestedPassword = flagValue('--password');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Usage: npm run setup -- [--force] [--skip-db] [--password <password>]',
      '',
      '  --force              overwrite an existing server/.env / client/.env',
      '  --skip-db            do not run migrations and the seed',
      '  --password <value>   first super-admin password (default: generated)',
    ].join('\n'),
  );
  process.exit(0);
}

if (Number(process.versions.node.split('.')[0]) < 20 || (process.versions.node.startsWith('20.') && Number(process.versions.node.split('.')[1]) < 12)) {
  console.error('[setup] Node.js 20.12 or newer is required (process.loadEnvFile).');
  process.exit(1);
}

// -------------------------------------------------------------- values -----
const superAdminEmail = process.env.SEED_SUPER_ADMIN_EMAIL?.trim() || 'admin@investorportal.local';
const superAdminName = process.env.SEED_SUPER_ADMIN_NAME?.trim() || 'Super Admin';
const superAdminPassword =
  requestedPassword?.trim() ||
  process.env.SEED_SUPER_ADMIN_PASSWORD?.trim() ||
  `Admin@${crypto.randomBytes(9).toString('base64url')}`;

/** Local development overrides applied on top of server/.env.example. */
const overrides = {
  NODE_ENV: 'development',
  PORT: '4000',
  CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,https://*.e2b.app',
  API_BASE_URL: 'http://localhost:4000',
  APP_BASE_URL: 'http://localhost:5173',
  TRUST_PROXY: '0',
  TURSO_DATABASE_URL: 'file:./prisma/dev.db',
  TURSO_AUTH_TOKEN: '',
  TEST_DATABASE_URL: 'file:./prisma/test.db',
  JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  NID_HASH_PEPPER: crypto.randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false',
  BKASH_MODE: 'sandbox',
  BKASH_BASE_URL: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta',
  BKASH_APP_KEY: '',
  BKASH_APP_SECRET: '',
  BKASH_USERNAME: '',
  BKASH_PASSWORD: '',
  STORAGE_DRIVER: 'auto',
  SMS_PROVIDER: 'console',
  RUN_JOBS: 'true',
  LOG_LEVEL: 'info',
  SEED_SUPER_ADMIN_EMAIL: superAdminEmail,
  SEED_SUPER_ADMIN_PASSWORD: superAdminPassword,
  SEED_SUPER_ADMIN_NAME: superAdminName,
};

/** Renders a value the way `server/.env` expects it (quoted when needed). */
function renderValue(value) {
  if (value === '') return '""';
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Replaces `KEY=...` lines and comments-documents every override. */
function renderServerEnv(template) {
  const lines = template.split('\n');
  const seen = new Set();
  const rendered = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in overrides)) return line;
    seen.add(key);
    return `${key}=${renderValue(overrides[key])}`;
  });

  const missing = Object.entries(overrides).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    rendered.push('', '# ------------------- added by `npm run setup` -------------------');
    for (const [key, value] of missing) rendered.push(`${key}=${renderValue(value)}`);
  }
  return rendered.join('\n');
}

// ------------------------------------------------------------ env files ----
const serverEnvFile = path.join(serverRoot, '.env');
const serverEnvExample = path.join(serverRoot, '.env.example');

if (!fs.existsSync(serverEnvExample)) {
  console.error(`[setup] missing template: ${serverEnvExample}`);
  process.exit(1);
}

let wroteServerEnv = false;
if (fs.existsSync(serverEnvFile) && !force) {
  console.log('[setup] server/.env already exists - left untouched (use --force to regenerate)');
} else {
  fs.mkdirSync(path.dirname(serverEnvFile), { recursive: true });
  fs.writeFileSync(serverEnvFile, renderServerEnv(fs.readFileSync(serverEnvExample, 'utf8')));
  wroteServerEnv = true;
  console.log(`[setup] wrote ${path.relative(portalRoot, serverEnvFile)} (local SQLite, generated secrets)`);
}

const clientEnvFile = path.join(portalRoot, 'client', '.env');
if (fs.existsSync(clientEnvFile) && !force) {
  console.log('[setup] client/.env already exists - left untouched (use --force to regenerate)');
} else {
  fs.mkdirSync(path.dirname(clientEnvFile), { recursive: true });
  fs.writeFileSync(
    clientEnvFile,
    [
      '# Base URL of the API server. Leave EMPTY in development: the Vite dev',
      '# server proxies /api to http://127.0.0.1:4000 (see vite.config.ts).',
      'VITE_API_BASE_URL=',
      '',
    ].join('\n'),
  );
  console.log('[setup] wrote client/.env (empty VITE_API_BASE_URL -> Vite proxy)');
}

// ---------------------------------------------------------------- db -------
if (skipDb) {
  console.log('[setup] --skip-db: skipping migrations and seed');
} else {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (args, label) => {
    console.log(`\n[setup] ${label}`);
    const result = spawnSync(npm, args, { cwd: portalRoot, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`[setup] ${label} failed (exit ${result.status ?? 'unknown'})`);
      process.exit(result.status ?? 1);
    }
  };
  // `postinstall` usually does this already; running it again is harmless and
  // makes the script work when dependencies were installed with --ignore-scripts.
  run(['--workspace', 'server', 'run', 'prisma:generate'], 'generating the Prisma client...');
  run(['--workspace', 'server', 'run', 'db:migrate'], 'applying database migrations...');
  run(['--workspace', 'server', 'run', 'seed'], 'seeding the first super admin and default settings...');
}

// -------------------------------------------------------------- summary ----
/** Reads the credentials that are actually in effect for the seed. */
function readSeededCredentials() {
  const fallback = { email: superAdminEmail, password: superAdminPassword };
  if (wroteServerEnv || !fs.existsSync(serverEnvFile)) return fallback;
  const raw = fs.readFileSync(serverEnvFile, 'utf8');
  const pick = (key) => {
    const match = raw.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    if (!match) return undefined;
    return match[1].trim().replace(/^"(.*)"$/, '$1');
  };
  return {
    email: pick('SEED_SUPER_ADMIN_EMAIL') || fallback.email,
    // An empty SEED_SUPER_ADMIN_PASSWORD makes the seed print a one-time password.
    password: pick('SEED_SUPER_ADMIN_PASSWORD') || '',
  };
}

const seeded = readSeededCredentials();
const existingHint = wroteServerEnv
  ? ''
  : ' (from the existing server/.env - a seed never changes an existing admin password)';
const passwordLine = seeded.password
  ? `  Password: ${seeded.password}${existingHint}`
  : '  Password: the one-time password printed by the seed when the super admin was created';

console.log(
  [
    '',
    '──────────────────────────────────────────────────────────────',
    ' Local setup complete',
    '──────────────────────────────────────────────────────────────',
    `  Login:    ${seeded.email}${existingHint}`,
    passwordLine,
    '',
    '  Start the app:   npm run dev',
    '                   API  http://localhost:4000',
    '                   SPA  http://localhost:5173',
    '',
    '  Not configured yet (development fallbacks are used):',
    '    - bKash    -> mock gateway, set BKASH_* in server/.env for sandbox/live',
    '    - SMS      -> console provider, set SMS_PROVIDER/SMS_API_* for a real gateway',
    '    - storage  -> local disk, set STORAGE_DRIVER=cloudinary + CLOUDINARY_* to use Cloudinary',
    '  Optional demo data: npm run seed:demo',
    '──────────────────────────────────────────────────────────────',
    '',
  ].join('\n'),
);
