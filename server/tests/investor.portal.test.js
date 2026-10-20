/**
 * Investor self-service portal integration tests:
 *  - admin issues/enables/disables/resets portal access (RBAC included)
 *  - investor login by mobile OR member code, lockout, forced password change
 *  - strict separation: investor cookie != admin cookie, own data only
 *  - dashboard numbers, profile self-update, documents, receipt, statement
 */
// Keep the lockout test short: 3 failures instead of the production 5.
process.env.INVESTOR_LOCKOUT_THRESHOLD = '3';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, makeClient, createInvestorWithInvestment, nextMobile } from './helpers/harness.js';

let ctx;
let superAdmin;
let accountant;
let viewer;

const TEMP_PASSWORD = 'TempPass2026x';
const FINAL_PASSWORD = 'MyOwnPass2026';

before(async () => {
  ctx = await createTestContext();
  superAdmin = await ctx.loginAs('SUPER_ADMIN');
  accountant = await ctx.loginAs('ACCOUNTANT');
  viewer = await ctx.loginAs('VIEWER');
});

after(async () => {
  await ctx?.close();
});

async function investorClient() {
  const { resetRateLimits } = await import('../src/middleware/security.js');
  resetRateLimits();
  return makeClient(ctx.baseUrl);
}

/** Logs in with a temporary password and completes the forced change. */
async function loginReady(loginId, tempPassword, finalPassword = FINAL_PASSWORD) {
  const client = await investorClient();
  const login = await client.post('/api/portal/auth/login', { loginId, password: tempPassword });
  assert.equal(login.status, 200, `portal login failed: ${JSON.stringify(login.body)}`);
  if (login.data.investor.must_change_password) {
    const changed = await client.post('/api/portal/auth/change-password', {
      currentPassword: tempPassword,
      newPassword: finalPassword,
    });
    assert.equal(changed.status, 200, `change-password failed: ${JSON.stringify(changed.body)}`);
  }
  return client;
}

/** Admin-side: create an investor WITHOUT portal access, plus an investment. */
async function makeInvestor(overrides = {}) {
  return createInvestorWithInvestment(superAdmin, { mobile: nextMobile(), ...overrides });
}

describe('portal access provisioning (admin side)', () => {
  test('new investors get a member code and no password material leaks', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    assert.match(investor.member_code, /^INV-\d{6}$/);
    assert.equal(investor.has_portal_password, false);
    assert.equal(investor.portal_enabled, false);

    const detail = await superAdmin.get(`/api/investors/${investor.id}`);
    assert.equal(detail.status, 200);
    assert.equal('password_hash' in detail.data.investor, false, 'password_hash must never be returned');
    assert.equal(detail.data.investor.member_code, investor.member_code);

    const access = await superAdmin.get(`/api/investors/${investor.id}/portal-access`);
    assert.equal(access.status, 200);
    assert.equal(access.data.portal.has_password, false);
    assert.equal(access.data.portal.last_login_at, null);
  });

  test('enabling without a password is refused; setting one enables access', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    const enable = await superAdmin.post(`/api/investors/${investor.id}/portal-access/enabled`, { enabled: true });
    assert.equal(enable.status, 400);

    const set = await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    assert.equal(set.status, 200);
    assert.equal(set.data.tempPassword, TEMP_PASSWORD);
    assert.equal(set.data.portal.portal_enabled, true);
    assert.equal(set.data.portal.must_change_password, true);

    // The plaintext never reaches the audit log.
    const auditRows = await ctx.query(
      `select new_value, meta, action from audit_logs where entity_id = ?1 and action = 'INVESTOR_PASSWORD_SET'`,
      [String(investor.id)],
    );
    assert.equal(auditRows.rows.length, 1);
    assert.ok(!JSON.stringify(auditRows.rows[0]).includes(TEMP_PASSWORD));
  });

  test('generated temporary passwords are readable and SMS preview is redacted', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    const set = await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { sendSms: true });
    assert.equal(set.status, 200);
    assert.equal(set.data.generated, true);
    assert.match(set.data.tempPassword, /^[A-Z][a-z]+-\d{4}[!@#*]$/);
    assert.equal(set.data.sms.sent, true);

    // The real SMS carries the password; the stored preview must not.
    const sms = ctx.smsProvider.sent.at(-1);
    assert.ok(sms.message.includes(set.data.tempPassword));
    const log = await ctx.query(`select body_preview from sms_logs where template_key = 'PORTAL_CREDENTIALS' order by id desc limit 1`);
    assert.ok(!log.rows[0].body_preview.includes(set.data.tempPassword), 'sms_logs preview leaked the password');
  });

  test('RBAC: viewer cannot manage portal access and sees a masked mobile; accountant can', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });

    const viewerSet = await viewer.post(`/api/investors/${investor.id}/portal-access/password`, {});
    assert.equal(viewerSet.status, 403);

    const viewerView = await viewer.get(`/api/investors/${investor.id}/portal-access`);
    assert.equal(viewerView.status, 200);
    assert.match(viewerView.data.portal.mobile, /\*/);

    const accountantSet = await accountant.post(`/api/investors/${investor.id}/portal-access/password`, {
      password: TEMP_PASSWORD,
    });
    assert.equal(accountantSet.status, 200);
  });

  test('investor can be created with portal access and profile fields in one go', async () => {
    const mobile = nextMobile();
    const created = await superAdmin.post('/api/investors', {
      name: 'Portal Ready',
      mobile,
      email: 'investor1@test.local',
      father_name: 'Abdul Ready',
      date_of_birth: '1995-03-02',
      gender: 'FEMALE',
      portal: { enabled: true, password: TEMP_PASSWORD },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.portal.enabled, true);
    assert.equal(created.data.portal.tempPassword, TEMP_PASSWORD);
    assert.equal(created.data.investor.email, 'investor1@test.local');
    assert.equal(created.data.investor.father_name, 'Abdul Ready');

    const client = await loginReady(mobile, TEMP_PASSWORD);
    const profile = await client.get('/api/portal/profile');
    assert.equal(profile.data.profile.email, 'investor1@test.local');
    assert.equal(profile.data.profile.gender, 'FEMALE');
  });
});

describe('investor login', () => {
  test('temporary password forces a change before anything else works', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });

    const client = await investorClient();
    const login = await client.post('/api/portal/auth/login', { loginId: investor.mobile, password: TEMP_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.data.investor.must_change_password, true);
    const setCookie = login.headers.getSetCookie().join(';');
    assert.match(setCookie, /ip_investor_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);

    const me = await client.get('/api/portal/auth/me');
    assert.equal(me.status, 200);

    const blocked = await client.get('/api/portal/dashboard');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const weak = await client.post('/api/portal/auth/change-password', {
      currentPassword: TEMP_PASSWORD,
      newPassword: investor.mobile,
    });
    assert.equal(weak.status, 422, 'mobile number as password must be rejected');

    const same = await client.post('/api/portal/auth/change-password', {
      currentPassword: TEMP_PASSWORD,
      newPassword: TEMP_PASSWORD,
    });
    assert.equal(same.status, 400);

    const changed = await client.post('/api/portal/auth/change-password', {
      currentPassword: TEMP_PASSWORD,
      newPassword: FINAL_PASSWORD,
    });
    assert.equal(changed.status, 200);

    const dashboard = await client.get('/api/portal/dashboard');
    assert.equal(dashboard.status, 200);

    // Old temporary password is dead, the new one works.
    const reloginOld = await (await investorClient()).post('/api/portal/auth/login', {
      loginId: investor.mobile,
      password: TEMP_PASSWORD,
    });
    assert.equal(reloginOld.status, 401);
    const relogin = await (await investorClient()).post('/api/portal/auth/login', {
      loginId: investor.mobile,
      password: FINAL_PASSWORD,
    });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.data.investor.must_change_password, false);
    assert.ok(relogin.data.investor.last_login_at);
  });

  test('member code works as login id (any case, with or without dash)', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });

    for (const loginId of [investor.member_code, investor.member_code.toLowerCase(), investor.member_code.replace('-', '')]) {
      const login = await (await investorClient()).post('/api/portal/auth/login', { loginId, password: TEMP_PASSWORD });
      assert.equal(login.status, 200, `loginId ${loginId} should work`);
      assert.equal(login.data.investor.member_code, investor.member_code);
    }
  });

  test('unknown user and wrong password are indistinguishable; lockout after repeated failures', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });

    const client = await investorClient();
    const unknown = await client.post('/api/portal/auth/login', { loginId: '01799999999', password: TEMP_PASSWORD });
    assert.equal(unknown.status, 401);

    for (let i = 0; i < 2; i += 1) {
      const wrong = await client.post('/api/portal/auth/login', { loginId: investor.mobile, password: 'WrongPass123' });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.error.message, unknown.error.message, 'error must stay generic');
    }
    // Third failure reaches INVESTOR_LOCKOUT_THRESHOLD=3 (set at the top).
    const third = await client.post('/api/portal/auth/login', { loginId: investor.mobile, password: 'WrongPass123' });
    assert.equal(third.status, 423);
    const locked = await client.post('/api/portal/auth/login', { loginId: investor.mobile, password: TEMP_PASSWORD });
    assert.equal(locked.status, 423);
    assert.equal(locked.error.code, 'ACCOUNT_LOCKED');

    // An admin password reset clears the lock.
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const afterReset = await (await investorClient()).post('/api/portal/auth/login', {
      loginId: investor.mobile,
      password: TEMP_PASSWORD,
    });
    assert.equal(afterReset.status, 200);
  });

  test('reset revokes live sessions; disabling blocks login; inactive investors cannot login', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const client = await loginReady(investor.mobile, TEMP_PASSWORD);

    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: 'SecondTemp2026' });
    const stale = await client.get('/api/portal/auth/me');
    assert.equal(stale.status, 401, 'password reset must revoke existing sessions');

    const client2 = await loginReady(investor.mobile, 'SecondTemp2026');
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/enabled`, { enabled: false });
    assert.equal((await client2.get('/api/portal/auth/me')).status, 401, 'disabling must revoke sessions');
    const disabledLogin = await (await investorClient()).post('/api/portal/auth/login', {
      loginId: investor.mobile,
      password: FINAL_PASSWORD,
    });
    assert.equal(disabledLogin.status, 403);
    assert.match(disabledLogin.error.message, /disabled/i);

    await superAdmin.post(`/api/investors/${investor.id}/portal-access/enabled`, { enabled: true });
    await superAdmin.post(`/api/investors/${investor.id}/status`, { status: 'INACTIVE', reason: 'test' });
    const inactiveLogin = await (await investorClient()).post('/api/portal/auth/login', {
      loginId: investor.mobile,
      password: FINAL_PASSWORD,
    });
    assert.equal(inactiveLogin.status, 403);
    assert.match(inactiveLogin.error.message, /not active/i);
    await superAdmin.post(`/api/investors/${investor.id}/status`, { status: 'ACTIVE', reason: 'test cleanup' });
  });

  test('investor and admin sessions are fully separate', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const client = await loginReady(investor.mobile, TEMP_PASSWORD);

    for (const path of ['/api/investors', '/api/investments', '/api/payments', '/api/dashboard', '/api/auth/me']) {
      const res = await client.get(path);
      assert.equal(res.status, 401, `investor cookie must not work on ${path}`);
    }
    const adminOnPortal = await superAdmin.get('/api/portal/dashboard');
    assert.equal(adminOnPortal.status, 401, 'admin cookie must not work on the portal');
  });
});

describe('portal data (own records only)', () => {
  test('dashboard totals, overdue state and pay-now link issuance', async () => {
    // Schedule starts in the past -> first installments are overdue.
    const mine = await makeInvestor({ firstDueDate: '2026-01-31', installmentCount: 3, totalTaka: '9000' });
    const other = await makeInvestor({ firstDueDate: '2026-01-31', installmentCount: 2, totalTaka: '4000' });
    await superAdmin.post(`/api/investors/${mine.investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const client = await loginReady(mine.investor.mobile, TEMP_PASSWORD);

    // Pay the first installment in full (manual, recorded by admin).
    const first = mine.installments[0];
    const manual = await superAdmin.post('/api/payments/manual', {
      installmentId: first.id,
      amount: (Number(first.amount) / 100).toFixed(2),
      method: 'CASH',
      reference: 'TEST-PORTAL-001',
      notify: false,
    });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));

    const dashboard = await client.get('/api/portal/dashboard');
    assert.equal(dashboard.status, 200);
    const summary = dashboard.data.summary;
    assert.equal(summary.total_invested, 9000_00);
    assert.equal(summary.total_paid, Number(first.amount));
    assert.equal(summary.paid_installments, 1);
    assert.equal(summary.total_installments, 3);
    assert.ok(summary.overdue_count >= 1, 'past-due installments must count as overdue');
    assert.ok(summary.due_now > 0);
    assert.equal(summary.next_due.installment_id, mine.installments[1].id);

    // Only my installments are visible.
    const installments = await client.get('/api/portal/installments');
    assert.equal(installments.data.installments.length, 3);
    assert.ok(installments.data.installments.every((row) => row.investment_id === mine.investment.id));

    // Pay link for my own open installment works; for someone else's -> 404.
    const own = await client.post(`/api/portal/installments/${mine.installments[1].id}/pay-link`);
    assert.equal(own.status, 200);
    assert.match(own.data.path, /^\/pay\//);
    const foreign = await client.post(`/api/portal/installments/${other.installments[0].id}/pay-link`);
    assert.equal(foreign.status, 404);
    const settled = await client.post(`/api/portal/installments/${first.id}/pay-link`);
    assert.equal(settled.status, 400);

    // Payments + receipt: mine renders, the other investor's does not exist for me.
    const payments = await client.get('/api/portal/payments');
    assert.equal(payments.data.payments.length, 1);
    const paymentId = payments.data.payments[0].id;
    const receipt = await client.get(`/api/portal/payments/${paymentId}/receipt`);
    assert.equal(receipt.status, 200);
    assert.match(String(receipt.text), /RCPT-/);

    const otherFirst = other.installments[0];
    const otherManual = await superAdmin.post('/api/payments/manual', {
      installmentId: otherFirst.id,
      amount: (Number(otherFirst.amount) / 100).toFixed(2),
      method: 'CASH',
      reference: 'TEST-PORTAL-002',
      notify: false,
    });
    assert.equal(otherManual.status, 201);
    const foreignReceipt = await client.get(`/api/portal/payments/${otherManual.data.payment.id}/receipt`);
    assert.equal(foreignReceipt.status, 404);

    // Statement CSV downloads as CSV.
    const statement = await client.get('/api/portal/statement.csv');
    assert.equal(statement.status, 200);
    assert.match(statement.headers.get('content-type'), /text\/csv/);
    assert.match(String(statement.text), /Kind,Reference/);
  });

  test('profile self-update: contact fields save, identity fields are locked and every attempt is audited', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const client = await loginReady(investor.mobile, TEMP_PASSWORD);

    const before = await client.get('/api/portal/profile');
    const updated = await client.patch('/api/portal/profile', {
      email: 'investor2@test.local',
      present_address: 'House 1, Bogura',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.data.profile.email, 'investor2@test.local');
    assert.equal(updated.data.profile.present_address, 'House 1, Bogura');
    assert.ok(updated.data.completion.percent > before.data.completion.percent);
    assert.ok(updated.data.policy.locked_fields.includes('father_name'));
    assert.ok(updated.data.policy.editable_fields.includes('email'));

    // Identity data is office-managed: each attempt is refused and changes nothing.
    const attempts = [
      { name: 'Changed Name Attempt' },
      { mobile: '01799999999' },
      { father_name: 'Father Example' },
      { date_of_birth: '1992-07-21' },
    ];
    for (const body of attempts) {
      const refused = await client.patch('/api/portal/profile', body);
      assert.equal(refused.status, 403, JSON.stringify(body));
      assert.equal(refused.error.code, 'FIELD_LOCKED');
    }
    const after = await client.get('/api/portal/profile');
    assert.equal(after.data.profile.name, investor.name, 'name must not be self-editable');
    assert.equal(after.data.profile.mobile, investor.mobile, 'mobile must not be self-editable');
    assert.equal(after.data.profile.father_name, before.data.profile.father_name);
    assert.equal(after.data.profile.date_of_birth, before.data.profile.date_of_birth);

    // Admin notes / credential internals never leak into the profile DTO.
    assert.equal('notes' in updated.data.profile, false);
    assert.equal('password_hash' in updated.data.profile, false);
    assert.equal('failed_login_count' in updated.data.profile, false);

    const auditRows = await ctx.query(
      `select count(*) as count from audit_logs where action = 'PORTAL_LOCKED_FIELD_BLOCKED' and entity_id = ?1`,
      [String(investor.id)],
    );
    assert.equal(auditRows.rows[0].count, attempts.length);
    const updateRows = await ctx.query(
      `select count(*) as count from audit_logs where action = 'INVESTOR_PROFILE_UPDATED' and entity_id = ?1`,
      [String(investor.id)],
    );
    assert.ok(updateRows.rows[0].count >= 1);
  });

  test('documents: investor cannot upload; staff-set photo and NID scan are readable by the owner', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const client = await loginReady(investor.mobile, TEMP_PASSWORD);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    );
    const refusedPhoto = await client.upload('/api/portal/photo', png, 'image/png');
    assert.equal(refusedPhoto.status, 404, 'investor photo upload must not exist');
    const refusedScan = await client.upload('/api/portal/nid-scan', png, 'image/png');
    assert.equal(refusedScan.status, 404, 'investor NID upload must not exist');

    const staffPhoto = await superAdmin.upload(`/api/investors/${investor.id}/photo`, png, 'image/png');
    assert.equal(staffPhoto.status, 200, JSON.stringify(staffPhoto.body));
    const photo = await client.get('/api/portal/photo');
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('content-type'), /image\/png/);

    const staffScan = await superAdmin.upload(`/api/investors/${investor.id}/nid-scan`, png, 'image/png');
    assert.equal(staffScan.status, 200, JSON.stringify(staffScan.body));
    const scanBack = await client.get('/api/portal/nid-scan');
    assert.equal(scanBack.status, 200);

    const profile = await client.get('/api/portal/profile');
    assert.equal(profile.data.profile.has_photo, true);
    assert.equal(profile.data.profile.has_nid_scan, true);
    assert.equal(profile.data.policy.documents, 'office-managed');
  });

  test('logout revokes the session', async () => {
    const { investor } = await makeInvestor({ createInvestment: false });
    await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
    const client = await loginReady(investor.mobile, TEMP_PASSWORD);
    assert.equal((await client.get('/api/portal/auth/me')).status, 200);
    assert.equal((await client.post('/api/portal/auth/logout')).status, 200);
    assert.equal((await client.get('/api/portal/auth/me')).status, 401);
  });
});
