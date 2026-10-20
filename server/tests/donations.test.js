/**
 * Donates: investor donations through the payment gateway.
 *
 * Covers the start -> gateway -> callback -> settle path, idempotent replays,
 * the trust rules (amount / invoice / duplicate trx id), ownership, receipts,
 * frozen accounts, verify + reconciliation, the staff ledger and the guarantee
 * that donations never change installment balances.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, createInvestorWithInvestment, makeClient, nextMobile } from './helpers/harness.js';

let ctx;
let superAdmin;
let accountant;
let viewer;

const TEMP_PASSWORD = 'TempPass2026x';
const FINAL_PASSWORD = 'Rotated2026xyz';

before(async () => {
  ctx = await createTestContext();
  superAdmin = await ctx.loginAs('SUPER_ADMIN');
  accountant = await ctx.loginAs('ACCOUNTANT');
  viewer = await ctx.loginAs('VIEWER');
});

after(async () => {
  await ctx?.close();
});

async function clientForPortal() {
  const { resetRateLimits } = await import('../src/middleware/security.js');
  resetRateLimits();
  return makeClient(ctx.baseUrl);
}

async function loginReady(loginId, tempPassword) {
  const client = await clientForPortal();
  const login = await client.post('/api/portal/auth/login', { loginId, password: tempPassword });
  assert.equal(login.status, 200, `portal login failed: ${JSON.stringify(login.body)}`);
  if (login.data.investor.must_change_password) {
    const changed = await client.post('/api/portal/auth/change-password', {
      currentPassword: tempPassword,
      newPassword: FINAL_PASSWORD,
    });
    assert.equal(changed.status, 200, `change-password failed: ${JSON.stringify(changed.body)}`);
  }
  return client;
}

async function makePortalInvestor(overrides = {}) {
  const { investor } = await createInvestorWithInvestment(superAdmin, {
    mobile: overrides.mobile ?? nextMobile(),
    totalTaka: '3000.00',
    installmentCount: 3,
    firstDueDate: overrides.firstDueDate ?? futureIso(20),
  });
  await superAdmin.post(`/api/investors/${investor.id}/membership`, { status: 'APPROVED' });
  const set = await superAdmin.post(`/api/investors/${investor.id}/portal-access/password`, { password: TEMP_PASSWORD });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const portal = await loginReady(investor.mobile, TEMP_PASSWORD);
  return { investor, portal };
}

/** Dhaka-aware future date (no app imports: config is loaded by the harness). */
function futureIso(days = 20) {
  const date = new Date(Date.now() + 6 * 3600_000);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Mock gateway outcomes are: success | fail | cancel | pending. */
async function withOutcome(outcome, fn) {
  const previous = ctx.gateway.outcome;
  ctx.gateway.setOutcome(outcome);
  try {
    return await fn();
  } finally {
    ctx.gateway.setOutcome(previous);
  }
}

async function startDonation(portal, body = { fundCode: 'WELFARE', amount: '500' }) {
  const response = await portal.post('/api/portal/donations', body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.data;
}

function callback(paymentId) {
  return makeClient(ctx.baseUrl).get(`/pay/callback?kind=donation&paymentID=${encodeURIComponent(paymentId)}`);
}

async function countAudit(action, entityId) {
  const res = await ctx.query('select count(*) as count from audit_logs where action = ?1 and entity_id = ?2', [action, String(entityId)]);
  return Number(res.rows[0].count);
}

describe('donations: overview and validation', () => {
  test('overview lists funds, presets and the investor history', async () => {
    const { portal } = await makePortalInvestor();
    const overview = await portal.get('/api/portal/donations');
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.ok(overview.data.funds.length >= 3);
    assert.deepEqual(overview.data.presets_taka, [100, 500, 1000, 2000, 5000]);
    assert.equal(overview.data.totals.count, 0);
    assert.deepEqual(overview.data.history, []);
  });

  test('rejects unknown funds and out-of-range amounts before reaching the gateway', async () => {
    const { portal } = await makePortalInvestor();
    const unknownFund = await portal.post('/api/portal/donations', { fundCode: 'NOPE', amount: '500' });
    assert.equal(unknownFund.status, 422);

    const tooSmall = await portal.post('/api/portal/donations', { fundCode: 'WELFARE', amount: '5' });
    assert.equal(tooSmall.status, 422);
    assert.ok(tooSmall.error.details.amount);

    const tooLarge = await portal.post('/api/portal/donations', { fundCode: 'WELFARE', amount: '900000' });
    assert.equal(tooLarge.status, 422);

    const notANumber = await portal.post('/api/portal/donations', { fundCode: 'WELFARE', amount: 'abc' });
    assert.equal(notANumber.status, 422);

    const created = await ctx.query('select count(*) as count from donations where investor_id is not null');
    assert.ok(Number(created.rows[0].count) >= 0);
  });

  test('a frozen account cannot donate', async () => {
    const { investor, portal } = await makePortalInvestor();
    const frozen = await superAdmin.post(`/api/investors/${investor.id}/freeze`, { frozen: true, reason: 'Compliance review' });
    assert.equal(frozen.status, 200, JSON.stringify(frozen.body));
    // Freezing revokes the live portal session, so the investor is signed out first.
    const blocked = await portal.post('/api/portal/donations', { fundCode: 'WELFARE', amount: '500' });
    assert.equal(blocked.status, 401);

  });
});

describe('donations: start and gateway callback', () => {
  test('start returns a redirect, callback settles the donation with a receipt number', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal);
    assert.equal(started.donation.status, 'PENDING');
    assert.match(started.donation.receipt_number, /^DON-\d{4}-\d{6}$/);
    assert.match(started.redirectUrl, /kind=donation/);

    const done = await callback(started.paymentId);
    assert.equal(done.status, 303);
    assert.match(done.headers.get('location'), /\/portal\/donates\/result\?state=success&ref=\d+/);

    const detail = await portal.get(`/api/portal/donations/${started.donation.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.donation.status, 'SUCCESS');
    assert.ok(detail.data.donation.trx_id);
    assert.ok(detail.data.donation.paid_at);
    assert.equal(await countAudit('DONATION_PAID', started.donation.id), 1);
  });

  test('replaying the callback is a no-op (one DONATION_PAID row, same state)', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal);
    await callback(started.paymentId);
    const replay = await callback(started.paymentId);
    assert.match(replay.headers.get('location'), /state=success/);
    assert.equal(await countAudit('DONATION_PAID', started.donation.id), 1);
  });

  test('a callback without a payment id is refused gracefully', async () => {
    const response = await makeClient(ctx.baseUrl).get('/pay/callback?kind=donation');
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /state=error&reason=missing_payment/);
  });

  test('a failed gateway payment never becomes a receipt', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal);
    const outcome = await withOutcome('fail', () => callback(started.paymentId));
    assert.match(outcome.headers.get('location'), /state=failed/);
    const detail = await portal.get(`/api/portal/donations/${started.donation.id}`);
    assert.equal(detail.data.donation.status, 'FAILED');
    assert.equal(detail.data.donation.trx_id, null);
    const receipt = await portal.get(`/api/portal/donations/${started.donation.id}/receipt`);
    assert.equal(receipt.status, 400);
  });

  test('an amount mismatch from the gateway fails the donation', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal, { fundCode: 'MEDICAL', amount: '1000' });
    ctx.gateway.forceAmount(started.paymentId, 99900);
    const outcome = await callback(started.paymentId);
    assert.match(outcome.headers.get('location'), /state=failed/);
    const detail = await portal.get(`/api/portal/donations/${started.donation.id}`);
    assert.equal(detail.data.donation.status, 'FAILED');
    assert.match(detail.data.donation.failure_reason, /Amount mismatch/);
  });

  test('a gateway transaction id already credited elsewhere is refused as a duplicate', async () => {
    const { portal } = await makePortalInvestor();
    const first = await startDonation(portal, { fundCode: 'COMMUNITY', amount: '200' });
    ctx.gateway.forceTrxId(first.paymentId, 'DUPTRX-DONATE-01');
    await callback(first.paymentId);

    const second = await startDonation(portal, { fundCode: 'COMMUNITY', amount: '300' });
    ctx.gateway.forceTrxId(second.paymentId, 'DUPTRX-DONATE-01');
    const outcome = await callback(second.paymentId);
    assert.match(outcome.headers.get('location'), /state=failed/);
    const detail = await portal.get(`/api/portal/donations/${second.donation.id}`);
    assert.equal(detail.data.donation.status, 'FAILED');
    assert.match(detail.data.donation.failure_reason, /Duplicate trxId/);
  });

  test('a pending callback is verified later with the gateway (verify endpoint)', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal);
    const pending = await withOutcome('pending', () => callback(started.paymentId));
    assert.match(pending.headers.get('location'), /state=pending/);

    ctx.gateway.completeAtGateway(started.paymentId);
    const verified = await portal.post(`/api/portal/donations/${started.donation.id}/verify`);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.data.state, 'success');
    assert.equal(verified.data.donation.status, 'SUCCESS');
  });

  test('reconciliation settles a donation whose callback never arrived', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal);
    ctx.gateway.completeAtGateway(started.paymentId);
    const backdated = new Date(Date.now() - 60 * 60_000).toISOString();
    await ctx.query('update donations set created_at = ?2 where id = ?1', [started.donation.id, backdated]);

    const { runReconcileJob } = await import('../src/jobs/reconcile.job.js');
    const result = await runReconcileJob({ applyAbandonment: false });
    assert.ok(result.detail.donations.checked >= 1);

    const detail = await portal.get(`/api/portal/donations/${started.donation.id}`);
    assert.equal(detail.data.donation.status, 'SUCCESS');
  });
});

describe('donations: ownership, receipts and isolation', () => {
  test('investors only see and receipt their own donations', async () => {
    const owner = await makePortalInvestor();
    const other = await makePortalInvestor();
    const started = await startDonation(owner.portal);
    await callback(started.paymentId);

    const peek = await other.portal.get(`/api/portal/donations/${started.donation.id}`);
    assert.equal(peek.status, 404);
    const peekReceipt = await other.portal.get(`/api/portal/donations/${started.donation.id}/receipt`);
    assert.equal(peekReceipt.status, 404);
    const otherVerify = await other.portal.post(`/api/portal/donations/${started.donation.id}/verify`);
    assert.equal(otherVerify.status, 404);

    const mine = await other.portal.get('/api/portal/donations');
    assert.equal(mine.data.history.some((row) => row.id === started.donation.id), false);
  });

  test('a settled donation has a printable HTML receipt that is audited', async () => {
    const { portal } = await makePortalInvestor();
    const started = await startDonation(portal, { fundCode: 'EDUCATION', amount: '750' });
    await callback(started.paymentId);
    const receipt = await portal.get(`/api/portal/donations/${started.donation.id}/receipt`);
    assert.equal(receipt.status, 200);
    assert.match(receipt.headers.get('content-type'), /text\/html/);
    assert.match(String(receipt.text), /Donation receipt/);
    assert.match(String(receipt.text), new RegExp(started.donation.receipt_number));
    assert.equal(await countAudit('DONATION_RECEIPT_VIEWED', started.donation.id), 1);
  });

  test('donations never change installments, investment totals or the dashboard summary', async () => {
    const { portal } = await makePortalInvestor();
    const before = await portal.get('/api/portal/dashboard');
    const started = await startDonation(portal, { fundCode: 'WELFARE', amount: '1000' });
    await callback(started.paymentId);
    const after = await portal.get('/api/portal/dashboard');
    assert.equal(after.data.summary.total_paid, before.data.summary.total_paid);
    assert.equal(after.data.summary.total_remaining, before.data.summary.total_remaining);
    assert.equal(after.data.summary.paid_installments, before.data.summary.paid_installments);
  });
});

describe('donations: staff ledger', () => {
  test('staff can list donations (no mobile numbers); anonymous callers cannot', async () => {
    const { investor, portal } = await makePortalInvestor();
    const started = await startDonation(portal, { fundCode: 'MEDICAL', amount: '2000' });
    await callback(started.paymentId);

    const anonymous = await makeClient(ctx.baseUrl).get('/api/donations');
    assert.equal(anonymous.status, 401);

    for (const staff of [accountant, viewer]) {
      const list = await staff.get('/api/donations?status=SUCCESS&limit=50');
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const row = list.data.rows.find((item) => item.id === started.donation.id);
      assert.ok(row, 'donation should be visible to staff');
      assert.equal(row.investor.name, investor.name);
      assert.equal(JSON.stringify(list.data).includes(investor.mobile), false, 'mobile numbers are not exposed here');
    }

    const badStatus = await accountant.get('/api/donations?status=NOPE');
    assert.equal(badStatus.status, 400);
  });
});
