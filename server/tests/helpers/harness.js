/**
 * Test harness.
 *
 * Loads `.env` then `.env.test` (a tiny hand-written parser - no dotenv
 * dependency), points the client at an isolated, disposable test database
 * (a local file under .tmp/ unless .env.test names a *test* Turso database), resets
 * + migrates the schema, boots the real Express app on an ephemeral port and gives tests a
 * cookie-aware HTTP client.
 *
 * bKash and SMS are swapped for in-process fakes via adapter injection, so the
 * whole suite runs without any network access.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');

function loadEnvFile(file) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

/** Must run before any src import (config is read at module load). */
export function prepareEnv() {
  loadEnvFile(join(ROOT, '.env'));
  // Database settings never come from .env: a developer's .env may point at the real
  // Turso database. Only an explicit .env.test (or the disposable local default) is used.
  const dbEnvFromDotEnv = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const hadTestEnv = loadEnvFile(join(ROOT, '.env.test'));
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
  process.env.IS_TEST = 'true';
  if (!hadTestEnv) {
    // Disposable local database. The file name must contain "test" (enforced by config).
    mkdirSync(join(ROOT, '.tmp'), { recursive: true });
    process.env.TURSO_DATABASE_URL = `file:${join(ROOT, '.tmp', `test-${process.pid}.db`)}`;
    delete process.env.TURSO_AUTH_TOKEN;
  }
  const url = process.env.TURSO_DATABASE_URL ?? '';
  if (!/test/i.test(url) || (dbEnvFromDotEnv.url && url === dbEnvFromDotEnv.url)) {
    throw new Error(
      'Refusing to run tests: TURSO_DATABASE_URL in .env.test must name a *test* database and must not be the production URL.',
    );
  }
  process.env.JOBS_ENABLED = 'false';
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.SMS_PROVIDER = 'console';
  process.env.SMS_DRY_RUN = 'false';
  process.env.RATE_LIMIT_LOGIN_MAX = process.env.RATE_LIMIT_LOGIN_MAX ?? '10';
  // Test files fire hundreds of requests; keep only the login limiter tight so
  // the rate-limit assertions stay meaningful without tripping other suites.
  process.env.RATE_LIMIT_API_MAX = '100000';
  process.env.RATE_LIMIT_PAY_MAX = '100000';
  process.env.RATE_LIMIT_PAY_START_MAX = '100000';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(48).toString('base64url');
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || randomBytes(32).toString('hex');
  return { hadTestEnv };
}

export async function createTestContext({ reset = true, seed = true } = {}) {
  prepareEnv();

  const { runMigrations } = await import('../../src/db/migrate.js');
  const { closeDatabase, query, resetDatabaseForTests } = await import('../../src/db/client.js');
  const { createApp } = await import('../../src/app.js');
  const { setGateway, createMockGateway } = await import('../../src/services/gateways/index.js');
  const { setSmsProvider } = await import('../../src/services/sms.service.js');
  const { memoryProvider } = await import('../../src/services/sms/providers.js');
  const { createServer } = await import('node:http');

  if (reset) {
    await query('select 1');
    await resetDatabaseForTests();
  }
  await runMigrations();

  const smsProvider = memoryProvider();
  setSmsProvider(smsProvider);
  const gateway = createMockGateway({ outcome: 'success' });
  setGateway(gateway);

  const app = createApp({ serveStatic: false });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const context = {
    app,
    server,
    baseUrl,
    port,
    gateway,
    smsProvider,
    query,
    client: makeClient(baseUrl),
    async seedAdmins() {
      const { createAdmin, ensureFirstSuperAdmin } = await import('../../src/services/auth.service.js');
      const superResult = await ensureFirstSuperAdmin({
        name: 'Test Root',
        email: 'root@test.local',
        password: SUPER_ADMIN_PASSWORD,
      });
      const superAdmin = superResult.admin ?? (await query('select * from admins where email = ?1', ['root@test.local'])).rows[0];
      await query('update admins set must_change_password = false where id = ?1', [superAdmin.id]);
      const accountant = await createAdmin(
        { name: 'Test Accountant', email: 'accounts@test.local', password: ACCOUNTANT_PASSWORD, role: 'ACCOUNTANT' },
        { id: superAdmin.id, email: 'root@test.local', role: 'SUPER_ADMIN' },
        null,
      );
      const viewer = await createAdmin(
        { name: 'Test Viewer', email: 'viewer@test.local', password: VIEWER_PASSWORD, role: 'VIEWER' },
        { id: superAdmin.id, email: 'root@test.local', role: 'SUPER_ADMIN' },
        null,
      );
      return { superAdmin, accountant, viewer };
    },
    /** Logs in and returns a client bound to that session. */
    async loginAs(role) {
      // Rate limiters are per-process and shared by the whole test file.
      const { resetRateLimits } = await import('../../src/middleware/security.js');
      resetRateLimits();
      const credentials = {
        SUPER_ADMIN: ['root@test.local', SUPER_ADMIN_PASSWORD],
        ACCOUNTANT: ['accounts@test.local', ACCOUNTANT_PASSWORD],
        VIEWER: ['viewer@test.local', VIEWER_PASSWORD],
      }[role];
      const client = makeClient(baseUrl);
      const result = await client.post('/api/auth/login', { email: credentials[0], password: credentials[1] });
      if (result.status !== 200) throw new Error(`Login as ${role} failed: ${JSON.stringify(result.body)}`);
      return client;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase();
    },
  };

  if (seed) context.admins = await context.seedAdmins();
  return context;
}

// Strong test passwords that satisfy the policy without matching the seed names.
export const SUPER_ADMIN_PASSWORD = 'Apricot#Harbor#2026!v';
export const ACCOUNTANT_PASSWORD = 'Apricot#Ledger#2026!v';
export const VIEWER_PASSWORD = 'Apricot#Beacon#2026!v';
export const NEW_PASSWORD = 'Rotated#Cipher#2026!v';

// ---------------------------------------------------------------------------
// Cookie-aware HTTP client
// ---------------------------------------------------------------------------
export function makeClient(baseUrl) {
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function storeCookies(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /Max-Age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, decodeURIComponent(value));
    }
  }

  async function request(method, path, body, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    let payload;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        payload = body;
        headers['content-type'] = options.contentType ?? 'application/octet-stream';
      } else {
        payload = JSON.stringify(body);
        headers['content-type'] = 'application/json';
      }
    }
    if (options.cookies !== false) {
      const cookie = cookieHeader();
      if (cookie) headers.cookie = cookie;
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      redirect: options.redirect ?? 'manual',
    });
    storeCookies(response);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let parsed = null;
    if (contentType.includes('application/json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      body: parsed ?? text,
      data: parsed?.data,
      error: parsed?.error,
      text,
      location: response.headers.get('location'),
    };
  }

  return {
    jar,
    cookieHeader,
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body, options) => request('POST', path, body ?? {}, options),
    patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
    del: (path, body, options) => request('DELETE', path, body ?? {}, options),
    upload: (path, buffer, contentType, options) => request('POST', path, buffer, { ...options, contentType }),
    raw: request,
  };
}

/** Convenience: create investor + investment with a known schedule. */
export async function createInvestorWithInvestment(client, overrides = {}) {
  const investorPayload = {
    name: overrides.name ?? 'Test Investor',
    mobile: overrides.mobile ?? '01711000999',
    address: 'Test address, Dhaka',
    ...(overrides.nid ? { nid: overrides.nid } : {}),
    ...(overrides.nominees ? { nominees: overrides.nominees } : {}),
  };
  const investorResponse = await client.post('/api/investors', investorPayload);
  if (investorResponse.status !== 201) throw new Error(`create investor failed: ${JSON.stringify(investorResponse.body)}`);
  const investor = investorResponse.data.investor;

  const investmentPayload = {
    investorId: investor.id,
    totalAmount: overrides.totalTaka ?? '10000.01',
    installmentCount: overrides.installmentCount ?? 3,
    firstDueDate: overrides.firstDueDate ?? '2026-01-31',
    interval: overrides.interval ?? 'MONTHLY',
    title: 'Test investment',
    ...(overrides.createInvestment === false ? { skip: true } : {}),
  };
  if (overrides.createInvestment === false) return { investor, investment: null, installments: [] };

  const investmentResponse = await client.post('/api/investments', investmentPayload);
  if (investmentResponse.status !== 201) throw new Error(`create investment failed: ${JSON.stringify(investmentResponse.body)}`);
  const detail = await client.get(`/api/investments/${investmentResponse.data.investment.id}`);
  return { investor, investment: detail.data, installments: detail.data.installments };
}

export function nextMobile(offset = 0) {
  const n = Number(process.hrtime.bigint() % 90000000n) + offset;
  return `017${String(n).padStart(8, '0').slice(0, 8)}`;
}
