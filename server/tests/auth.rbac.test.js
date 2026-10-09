/**
 * Authentication + RBAC integration tests: lockout, 2FA, session rotation,
 * role enforcement on EVERY admin route and masking for the VIEWER role.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, NEW_PASSWORD, ACCOUNTANT_PASSWORD, SUPER_ADMIN_PASSWORD } from './helpers/harness.js';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx?.close();
});

describe('login', () => {
  test('rejects bad credentials with a generic error and writes an audit entry', async () => {
    const client = ctx.client;
    const response = await client.post('/api/auth/login', { email: 'root@test.local', password: 'WrongPassword#123' });
    assert.equal(response.status, 401);
    assert.match(response.error.message, /Invalid email or password/);

    const audit = await ctx.query(`select action from audit_logs where action = 'LOGIN_FAILED' order by id desc limit 1`);
    assert.equal(audit.rows[0]?.action, 'LOGIN_FAILED');
  });

  test('locks the account after repeated failures', async () => {
    const { createAdmin } = await import('../src/services/auth.service.js');
    const victim = await createAdmin(
      { name: 'Lock Victim', email: 'lockme@test.local', password: 'Locked#User#2026!x', role: 'VIEWER' },
      ctx.admins.superAdmin,
      null,
    );
    for (let i = 0; i < 5; i += 1) {
      await ctx.client.post('/api/auth/login', { email: 'lockme@test.local', password: 'nope-nope-nope-1!' });
    }
    const locked = await ctx.client.post('/api/auth/login', { email: 'lockme@test.local', password: 'Locked#User#2026!x' });
    assert.equal(locked.status, 423);
    assert.equal(locked.error.code, 'ACCOUNT_LOCKED');

    const row = await ctx.query('select locked_until, failed_login_count from admins where id = $1', [victim.id]);
    assert.ok(row.rows[0].locked_until, 'locked_until must be set');
    await ctx.query(`update admins set locked_until = null, failed_login_count = 0 where id = $1`, [victim.id]);
  });

  test('successful login sets an httpOnly + SameSite=Strict session cookie', async () => {
    const client = ctx.client;
    const response = await client.post('/api/auth/login', { email: 'root@test.local', password: SUPER_ADMIN_PASSWORD });
    assert.equal(response.status, 200);
    const setCookie = response.headers.getSetCookie().join(';');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.admin.role, 'SUPER_ADMIN');
  });

  test('unauthenticated requests are refused', async () => {
    const anon = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    for (const path of ['/api/investors', '/api/investments', '/api/payments', '/api/dashboard', '/api/audit', '/api/admins']) {
      const response = await anon.get(path);
      assert.equal(response.status, 401, `${path} must require a session`);
    }
  });
});

describe('2FA (TOTP)', () => {
  test('setup -> confirm -> login requires a code and blocks replay', async () => {
    const { createAdmin } = await import('../src/services/auth.service.js');
    const { generateTotp } = await import('../src/services/crypto.service.js');
    const email = 'totp@test.local';
    await createAdmin({ name: 'Totp User', email, password: 'Aegis#Circuit#2026!x', role: 'ACCOUNTANT' }, ctx.admins.superAdmin, null);

    const client = await ctx.loginAs('ACCOUNTANT');
    const accountantClient = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    let response = await accountantClient.post('/api/auth/login', { email, password: 'Aegis#Circuit#2026!x' });
    assert.equal(response.status, 200);
    const sessionClient = accountantClient;

    const setup = await sessionClient.post('/api/auth/totp/setup');
    assert.equal(setup.status, 200);
    assert.match(setup.data.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.data.otpauthUri, /^otpauth:\/\/totp\//);

    const wrong = await sessionClient.post('/api/auth/totp/confirm', { code: '000000' });
    assert.equal(wrong.status, 400);
    const wrongAudit = await ctx.query(
      `select count(*)::int as count from audit_logs where action = 'TOTP_VERIFY_FAILED' and entity_id = (select id::text from admins where email = $1)`,
      [email],
    );
    assert.ok(wrongAudit.rows[0].count >= 1);

    const code = generateTotp(setup.data.secret);
    const confirmed = await sessionClient.post('/api/auth/totp/confirm', { code });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.totp_enabled, true);

    // Login now needs a second factor
    const fresh = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    const noCode = await fresh.post('/api/auth/login', { email, password: 'Aegis#Circuit#2026!x' });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.error.code, 'TOTP_REQUIRED');

    // The confirm above already consumed the current 30s step, so logins must
    // use the *next* step's code (the ±1 window accepts it). Reusing a step is
    // rejected by the replay guard, which is exactly what we assert next.
    const nextStep = Date.now() + 30_000;
    const loginCode = generateTotp(setup.data.secret, { instantMs: nextStep });
    const withCode = await fresh.post('/api/auth/login', { email, password: 'Aegis#Circuit#2026!x', totpCode: loginCode });
    assert.equal(withCode.status, 200);

    // Replaying a consumed code must fail
    const replay = await (await import('./helpers/harness.js')).makeClient(ctx.baseUrl).post('/api/auth/login', {
      email,
      password: 'Aegis#Circuit#2026!x',
      totpCode: loginCode,
    });
    assert.equal([401, 423].includes(replay.status), true);
    assert.ok(client);
  });
});

describe('sessions', () => {
  test('refresh rotates the token and revokes the old one', async () => {
    const client = await ctx.loginAs('ACCOUNTANT');
    const before = client.cookieHeader();
    const rotated = await client.post('/api/auth/refresh');
    assert.equal(rotated.status, 200);
    const afterCookie = client.cookieHeader();
    assert.notEqual(before, afterCookie, 'the session cookie must change on rotation');

    const old = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    old.jar.set('ip_session', decodeURIComponent(before.split('ip_session=')[1]));
    const oldSession = await old.get('/api/auth/me');
    assert.equal(oldSession.status, 401, 'the rotated-away token must stop working');

    const fresh = await client.get('/api/auth/me');
    assert.equal(fresh.status, 200);
  });

  test('logout clears the cookie and revokes the session', async () => {
    const client = await ctx.loginAs('VIEWER');
    assert.equal((await client.get('/api/auth/me')).status, 200);
    const loggedOut = await client.post('/api/auth/logout');
    assert.equal(loggedOut.status, 200);
    const after = await client.get('/api/auth/me');
    assert.equal(after.status, 401);
  });

  test('change-password requires the current password and enforces policy', async () => {
    const { createAdmin } = await import('../src/services/auth.service.js');
    const admin = await createAdmin(
      { name: 'Password User', email: 'pwd@test.local', password: 'Initial#Pass#2026!x', role: 'ACCOUNTANT' },
      ctx.admins.superAdmin,
      null,
    );
    const client = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    await client.post('/api/auth/login', { email: 'pwd@test.local', password: 'Initial#Pass#2026!x' });

    const wrongCurrent = await client.post('/api/auth/change-password', { currentPassword: 'nope', newPassword: NEW_PASSWORD });
    assert.equal(wrongCurrent.status, 401);

    const weak = await client.post('/api/auth/change-password', { currentPassword: 'Initial#Pass#2026!x', newPassword: 'short' });
    assert.equal(weak.status, 422);

    const same = await client.post('/api/auth/change-password', { currentPassword: 'Initial#Pass#2026!x', newPassword: 'Initial#Pass#2026!x' });
    assert.equal(same.status, 400);

    const ok = await client.post('/api/auth/change-password', { currentPassword: 'Initial#Pass#2026!x', newPassword: NEW_PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal((await client.get('/api/auth/me')).status, 200, 'the current session must survive');

    const relogin = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    const result = await relogin.post('/api/auth/login', { email: 'pwd@test.local', password: NEW_PASSWORD });
    assert.equal(result.status, 200);
    assert.equal(result.data.admin.must_change_password, false);
    assert.ok(admin.id);
  });
});

describe('RBAC on every admin route', () => {
  test('VIEWER can read but never write, and sees masked PII', async () => {
    const superClient = await ctx.loginAs('SUPER_ADMIN');
    const created = await superClient.post('/api/investors', {
      name: 'Masked Person',
      mobile: '01719998877',
      address: 'Secret street 5',
      nid: '1999887766554',
    });
    assert.equal(created.status, 201);
    const investorId = created.data.investor.id;

    const viewer = await ctx.loginAs('VIEWER');
    const list = await viewer.get('/api/investors?limit=5');
    assert.equal(list.status, 200);
    const row = list.data.items.find((item) => item.id === investorId);
    assert.equal(row.mobile, '0171*****77', 'VIEWER sees a masked mobile in place of the real one');
    assert.equal(row.mobile_masked, undefined, 'VIEWER responses carry no unmasked alias');
    assert.equal(row.address, '***');
    assert.equal(row.nid_last4, '****6554');
    assert.equal(row.nid_encrypted, undefined, 'ciphertext must never be exposed');

    const blocked = [
      ['post', '/api/investors', { name: 'X', mobile: '01710000001' }],
      ['patch', `/api/investors/${investorId}`, { name: 'Y' }],
      ['post', '/api/investments', { investorId, totalAmount: 1000, installmentCount: 1, firstDueDate: '2026-01-01' }],
      ['post', '/api/payments/manual', { installmentId: 1, amount: 1, method: 'CASH', reference: 'ABC-1' }],
      ['post', '/api/investments/1/status', { status: 'CANCELLED' }],
      ['post', '/api/installments/1/state', { status: 'WAIVED', reason: 'test' }],
      ['post', '/api/installments/1/send-link', {}],
      ['post', '/api/investors/1/restore', {}],
    ];
    for (const [method, path, body] of blocked) {
      const response = await viewer[method](path, body);
      assert.equal(response.status, 403, `VIEWER must not be able to ${method.toUpperCase()} ${path}`);
    }

    // Super-admin-only surfaces
    for (const path of ['/api/admins', '/api/audit', '/api/jobs']) {
      const response = await viewer.get(path);
      assert.equal(response.status, 403, `VIEWER must not reach ${path}`);
    }
    // The SMS *log* is readable by every authenticated role (it is masked); only
    // sending a test SMS is SUPER_ADMIN-only.
    assert.equal((await viewer.get('/api/sms')).status, 200);
    assert.equal((await viewer.post('/api/sms/test', { mobile: '01712345678' })).status, 403);
    const revealNid = await viewer.get(`/api/investors/${investorId}/nid`);
    assert.equal(revealNid.status, 403);
    const scan = await viewer.get(`/api/investors/${investorId}/nid-scan`);
    assert.equal(scan.status, 403);
  });

  test('ACCOUNTANT can run the money flows but not touch nominees, NIDs or admins', async () => {
    const superClient = await ctx.loginAs('SUPER_ADMIN');
    const investor = await superClient.post('/api/investors', { name: 'Accountant Target', mobile: '01716665544' });
    const investorId = investor.data.investor.id;

    const accountant = await ctx.loginAs('ACCOUNTANT');
    const investment = await accountant.post('/api/investments', {
      investorId,
      totalAmount: '3000.00',
      installmentCount: 3,
      firstDueDate: '2026-06-30',
      interval: 'MONTHLY',
    });
    assert.equal(investment.status, 201);

    const nominated = await accountant.post(`/api/investors/${investorId}/nominees`, {
      nominees: [{ name: 'N', relation: 'Son', mobile: '01710000002', share_percent: 100 }],
    });
    assert.equal(nominated.status, 403, 'nominee changes are SUPER_ADMIN only');

    const nidUpdate = await accountant.patch(`/api/investors/${investorId}`, { nid: '1990000000001' });
    assert.equal(nidUpdate.status, 400, 'NID edits are SUPER_ADMIN only');

    const admins = await accountant.get('/api/admins');
    assert.equal(admins.status, 403);

    const audit = await accountant.get('/api/audit');
    assert.equal(audit.status, 403, 'the audit log is SUPER_ADMIN only');

    const createInvestment = await accountant.post('/api/investments', {
      investorId,
      totalAmount: '100.00',
      installmentCount: 1,
      firstDueDate: '2026-07-01',
    });
    assert.equal(createInvestment.status, 201, 'accountants manage investments');
    assert.equal((await accountant.get('/api/dashboard')).status, 200);
    assert.equal((await accountant.get('/api/reports/due')).status, 200);
    assert.equal((await accountant.get('/api/jobs')).status, 403);
  });

  test('cross-origin state-changing requests are blocked (CSRF guard)', async () => {
    const client = await ctx.loginAs('ACCOUNTANT');
    const response = await client.post(
      '/api/investors',
      { name: 'Evil', mobile: '01710000009' },
      { headers: { origin: 'https://evil.example.com' } },
    );
    assert.equal(response.status, 403);
    assert.match(response.error.message, /Cross-origin/);
  });

  test('security headers are present on API responses', async () => {
    const response = await ctx.client.get('/api/health');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('referrer-policy') ?? '', /strict-origin/);
    assert.ok(response.headers.get('x-request-id'));
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  test('login rate limiting kicks in', async () => {
    const client = (await import('./helpers/harness.js')).makeClient(ctx.baseUrl);
    let sawLimited = false;
    for (let i = 0; i < 14; i += 1) {
      const response = await client.post('/api/auth/login', { email: 'ratelimit@test.local', password: `Bad#Pass#2026!${i}` });
      if (response.status === 429) {
        sawLimited = true;
        assert.ok(response.headers.get('retry-after'));
        break;
      }
    }
    assert.equal(sawLimited, true, 'the login limiter must eventually return 429');
    const { resetRateLimits } = await import('../src/middleware/security.js');
    resetRateLimits();
  });
});

describe('admin management', () => {
  test('SUPER_ADMIN creates, disables and resets admins; the last super admin is protected', async () => {
    const superClient = await ctx.loginAs('SUPER_ADMIN');
    const created = await superClient.post('/api/admins', {
      name: 'New Accountant',
      email: 'newbie@test.local',
      password: 'Bramble#Anvil#2026!x',
      role: 'ACCOUNTANT',
    });
    assert.equal(created.status, 201);

    const dupe = await superClient.post('/api/admins', {
      name: 'New Accountant',
      email: 'NEWBIE@test.local',
      password: 'Bramble#Anvil#2026!x',
      role: 'ACCOUNTANT',
    });
    assert.equal(dupe.status, 409);

    const disabled = await superClient.patch(`/api/admins/${created.data.admin.id}`, { is_active: false, disabled_reason: 'left the company' });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.admin.is_active, false);

    const login = await (await import('./helpers/harness.js')).makeClient(ctx.baseUrl).post('/api/auth/login', {
      email: 'newbie@test.local',
      password: 'Bramble#Anvil#2026!x',
    });
    assert.equal(login.status, 403);

    const reset = await superClient.post(`/api/admins/${created.data.admin.id}/reset-password`, { newPassword: NEW_PASSWORD });
    assert.equal(reset.status, 200);

    const lastSuper = await superClient.patch(`/api/admins/${ctx.admins.superAdmin.id}`, { role: 'VIEWER' });
    assert.equal(lastSuper.status, 409, 'at least one active SUPER_ADMIN must remain');
    assert.equal((await superClient.patch(`/api/admins/${ctx.admins.accountant.id}`, { role: 'SUPER_ADMIN' })).status, 200);
  });

  test('self-disable is refused', async () => {
    const superClient = await ctx.loginAs('SUPER_ADMIN');
    const response = await superClient.patch(`/api/admins/${ctx.admins.superAdmin.id}`, { is_active: false });
    assert.equal(response.status, 409);
  });
});
