/**
 * Payments + payment links: token hashing/expiry/regeneration, the full gateway
 * flow against the in-process mock (start -> callback/execute -> settle),
 * idempotent callbacks, duplicate trxId, amount mismatch, cancelled/failed
 * payments, reconciliation, manual payments, receipts, SMS and jobs.
 *
 * The mock gateway implements the same adapter interface as bKash, including
 * "never trust the browser, always re-query/execute server-side".
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestContext, createInvestorWithInvestment, makeClient, nextMobile } from './helpers/harness.js';

let ctx;
let admin;
let accountant;

before(async () => {
  ctx = await createTestContext();
  admin = await ctx.loginAs('SUPER_ADMIN');
  accountant = await ctx.loginAs('ACCOUNTANT');
});

after(async () => {
  await ctx?.close();
});

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

/** Dhaka-aware future date (no app imports: config is loaded by the harness). */
function futureIso(days = 20) {
  const date = new Date(Date.now() + 6 * 3600_000);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createPayable(overrides = {}) {
  const created = await createInvestorWithInvestment(admin, {
    name: overrides.name ?? 'Pay Tester',
    mobile: overrides.mobile ?? nextMobile(70),
    totalTaka: overrides.totalTaka ?? '3000.00',
    installmentCount: overrides.installmentCount ?? 3,
    firstDueDate: overrides.firstDueDate ?? futureIso(20),
  });
  const installment = created.installments[0];
  const link = await accountant.post(`/api/installments/${installment.id}/pay-link`, { regenerate: true });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  return { ...created, installment, link: link.data };
}

async function startPayment(token, client) {
  const anon = client ?? makeClient(ctx.baseUrl);
  const response = await anon.post(`/api/public/pay/${token}/start`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { anon, ...response.data };
}

function callback(anon, token, paymentId, extra = '') {
  return anon.get(`/pay/callback?link=${encodeURIComponent(token)}&paymentID=${encodeURIComponent(paymentId)}${extra}`);
}

/** The reconcile job only looks at attempts older than the configured threshold. */
async function backdatePayment(paymentId, minutes = 30) {
  await ctx.query(`update payments set created_at = now() - ($2 || ' minutes')::interval where id = $1`, [paymentId, String(minutes)]);
}

describe('payment links', () => {
  test('stores only a hash of the token and hands the URL out once', async () => {
    const { installment, link } = await createPayable();
    assert.match(link.url, /\/pay\/[A-Za-z0-9_-]{43}$/);
    assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(link.tokenExpiresAt !== null, true);

    const stored = await ctx.query('select pay_token_hash, token_expires_at from installments where id = $1', [installment.id]);
    assert.equal(stored.rows[0].pay_token_hash, createHash('sha256').update(link.token).digest('hex'));
    assert.ok(new Date(stored.rows[0].token_expires_at).getTime() > Date.now());

    const detail = await admin.get(`/api/investments/${installment.investment_id}`);
    const row = detail.data.installments.find((item) => item.id === installment.id);
    assert.ok(row.pay_token_hash);
    assert.equal(row.pay_token, undefined);
    assert.equal(JSON.stringify(detail.data).includes(link.token), false, 'the raw token must never be echoed back');
  });

  test('the public view exposes only first name, installment number, amount and due date', async () => {
    const { installment, link } = await createPayable({ name: 'Shahriar Kabir Hossain', mobile: '01715556677' });
    const anon = makeClient(ctx.baseUrl);
    const view = await anon.get(`/api/public/pay/${link.token}`);
    assert.equal(view.status, 200);
    assert.equal(view.data.firstName, 'Shahriar');
    assert.equal(view.data.installmentNumber, installment.serial);
    assert.equal(view.data.amount, installment.amount);
    assert.equal(view.data.dueDate, futureIso(20));
    assert.equal(view.data.status, 'PENDING');
    assert.equal(view.data.canPay, true);
    assert.equal(view.data.mobileHint, '0171*****77');

    const serialized = JSON.stringify(view.data);
    assert.ok(!serialized.includes('Kabir'), 'no full name may leak');
    assert.ok(!serialized.includes('01715556677'), 'no full mobile may leak');
    assert.ok(!/\bnid\b/i.test(serialized), 'no NID field may leak');
  });

  test('regeneration invalidates the previous token immediately', async () => {
    const { installment, link } = await createPayable();
    const anon = makeClient(ctx.baseUrl);
    assert.equal((await anon.get(`/api/public/pay/${link.token}`)).status, 200);

    const regenerated = await accountant.post(`/api/installments/${installment.id}/pay-link`, { regenerate: true });
    assert.equal(regenerated.status, 200);
    assert.notEqual(regenerated.data.token, link.token);

    const old = await anon.get(`/api/public/pay/${link.token}`);
    assert.equal(old.status, 404);
    assert.equal(old.error.code, 'LINK_INVALID');
    assert.match(old.error.message, /not valid/);
    assert.equal((await anon.get(`/api/public/pay/${regenerated.data.token}`)).status, 200);

    // Fresh issuance (no live link) is a generation; replacing one is a regeneration.
    const auditFor = async () =>
      (
        await ctx.query(
          `select action, old_value from audit_logs
             where entity = 'installment' and entity_id = $1
               and action in ('PAY_LINK_GENERATED', 'PAY_LINK_REGENERATED')
             order by id`,
          [String(installment.id)],
        )
      ).rows;
    const before = await auditFor();
    assert.equal(before.at(-1).action, 'PAY_LINK_REGENERATED', 'replacing a live link is audited as a regeneration');
    assert.ok(before.at(-1).old_value, 'the regeneration records the old token version');

    await ctx.query(`update installments set pay_token_hash = null, token_expires_at = null, token_issued_at = null where id = $1`, [
      installment.id,
    ]);
    const fresh = await accountant.post(`/api/installments/${installment.id}/pay-link`, {});
    assert.equal(fresh.status, 200);
    const after = await auditFor();
    assert.equal(after.at(-1).action, 'PAY_LINK_GENERATED', 'a first-ever link is audited as a generation');
  });

  test('expired links are refused for viewing and for starting a payment', async () => {
    const { installment, link } = await createPayable();
    await ctx.query(`update installments set token_expires_at = now() - interval '1 day' where id = $1`, [installment.id]);

    const anon = makeClient(ctx.baseUrl);
    const view = await anon.get(`/api/public/pay/${link.token}`);
    assert.equal(view.status, 410);
    assert.equal(view.error.code, 'LINK_EXPIRED');

    const start = await anon.post(`/api/public/pay/${link.token}/start`);
    assert.equal(start.status, 410);

    const audit = await ctx.query(`select count(*)::int as count from audit_logs where action = 'PAY_LINK_INVALID'`);
    assert.ok(audit.rows[0].count >= 1, 'rejected link accesses are audited');
  });

  test('unknown tokens get the same generic 404 as anything else invalid', async () => {
    const anon = makeClient(ctx.baseUrl);
    const response = await anon.get('/api/public/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(response.status, 404);
    assert.match(response.error.message, /not valid/);
    assert.equal(response.error.details, undefined);
    const { resetRateLimits } = await import('../src/middleware/security.js');
    resetRateLimits();
  });
});

describe('gateway payment flow (mock gateway)', () => {
  test('start + callback settles the installment in one transaction', async () => {
    const { installment, investment, link } = await createPayable();

    const { anon, paymentId, redirectUrl } = await startPayment(link.token);
    assert.match(redirectUrl, /\/pay\/callback\?/);
    assert.ok(paymentId);

    const initiated = await ctx.query('select status, method, gateway, invoice_number from payments where gateway_payment_id = $1', [paymentId]);
    assert.equal(initiated.rows[0].status, 'INITIATED');
    assert.equal(initiated.rows[0].method, 'BKASH');
    assert.equal(initiated.rows[0].gateway, 'BKASH');

    const settled = await callback(anon, link.token, paymentId);
    assert.equal(settled.status, 303);
    assert.match(settled.location, /state=success/);

    const payment = await ctx.query('select id, status, trx_id from payments where gateway_payment_id = $1', [paymentId]);
    assert.equal(payment.rows[0].status, 'SUCCESS');
    assert.match(payment.rows[0].trx_id, /^MOCKTRX/);

    const after = await ctx.query('select status, paid_at, amount_paid from installments where id = $1', [installment.id]);
    assert.equal(after.rows[0].status, 'PAID');
    assert.ok(after.rows[0].paid_at);
    assert.equal(Number(after.rows[0].amount_paid), installment.amount);

    // Collected totals are derived from installments (no denormalised column).
    const investmentDetail = await admin.get(`/api/investments/${investment.id}`);
    assert.equal(Number(investmentDetail.data.amount_collected), installment.amount);

    // The result page re-reads the state from the server (never from the query string)
    const verify = await anon.post(`/api/public/pay/${link.token}/verify`, { paymentId });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.state, 'success');
    assert.equal(verify.data.payment.status, 'SUCCESS');
    assert.match(verify.data.payment.receiptNumber, /^RCPT-\d{4}-\d{6}$/);
    assert.equal(verify.data.installment.status, 'PAID');
    assert.equal(verify.data.installment.canPay, false);

    // Confirmation SMS goes out from the settlement path
    assert.ok(
      ctx.smsProvider.sent.some((message) => message.messageType === 'PAYMENT_SUCCESS'),
      'a payment confirmation SMS must be sent',
    );

    const audit = await ctx.query(`select action from audit_logs where entity = 'payment' and entity_id = $1 order by id`, [
      String(payment.rows[0].id),
    ]);
    const actions = audit.rows.map((row) => row.action);
    assert.ok(actions.includes('PAYMENT_INITIATED'));
    assert.ok(actions.includes('PAYMENT_VERIFIED'));
  });

  test('the callback is idempotent when the browser or gateway replays it', async () => {
    const { installment, link } = await createPayable();
    const { anon, paymentId } = await startPayment(link.token);

    const first = await callback(anon, link.token, paymentId);
    const second = await callback(anon, link.token, paymentId);
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);
    assert.equal(second.location, first.location);

    const rows = await ctx.query('select status from payments where installment_id = $1', [installment.id]);
    assert.equal(rows.rows.length, 1, 'a replayed callback must not create a second payment row');
    assert.equal(rows.rows[0].status, 'SUCCESS');

    const paid = await ctx.query('select amount_paid from installments where id = $1', [installment.id]);
    assert.equal(Number(paid.rows[0].amount_paid), installment.amount, 'the installment must not be credited twice');
  });

  test('an attacker cannot force success through query parameters', async () => {
    const { installment, link } = await createPayable();
    await withOutcome('fail', async () => {
      const { anon, paymentId } = await startPayment(link.token);
      // Classic tampering: claim success (and inject a trxId/amount) in the return URL.
      const tampered = await callback(anon, link.token, paymentId, `&status=success&trxId=FAKE123&amount=${installment.amount}`);
      assert.equal(tampered.status, 303);
      assert.match(tampered.location, /state=failed/);

      const payment = await ctx.query('select id, status, trx_id from payments where gateway_payment_id = $1', [paymentId]);
      assert.equal(payment.rows[0].status, 'FAILED');
      assert.notEqual(payment.rows[0].trx_id, 'FAKE123');

      const inst = await ctx.query('select status, amount_paid from installments where id = $1', [installment.id]);
      assert.equal(inst.rows[0].status, 'PENDING');
      assert.equal(Number(inst.rows[0].amount_paid), 0);

      const audit = await ctx.query(
        `select count(*)::int as count from audit_logs where action = 'PAYMENT_FAILED' and entity_id = $1`,
        [String(payment.rows[0].id)],
      );
      assert.equal(audit.rows[0].count, 1);
    });
  });

  test('an amount mismatch fails the attempt instead of partially settling it', async () => {
    const { installment, link } = await createPayable();
    await withOutcome('success', async () => {
      const { anon, paymentId } = await startPayment(link.token);
      ctx.gateway.forceAmount(paymentId, installment.amount + 1);

      const result = await callback(anon, link.token, paymentId);
      assert.equal(result.status, 303);
      assert.match(result.location, /state=failed/);

      const payment = await ctx.query('select id, status, failure_reason from payments where gateway_payment_id = $1', [paymentId]);
      assert.equal(payment.rows[0].status, 'FAILED');
      assert.match(payment.rows[0].failure_reason, /Amount mismatch/i);

      const inst = await ctx.query('select status, amount_paid from installments where id = $1', [installment.id]);
      assert.equal(inst.rows[0].status, 'PENDING');
      assert.equal(Number(inst.rows[0].amount_paid), 0);
    });
  });

  test('a duplicate gateway trxId is rejected and never double-settles', async () => {
    const first = await createPayable();
    const second = await createPayable();
    const duplicateTrx = `DUPTRX${Date.now()}`;

    await withOutcome('success', async () => {
      const a = await startPayment(first.link.token);
      ctx.gateway.forceTrxId(a.paymentId, duplicateTrx);
      const settledA = await callback(a.anon, first.link.token, a.paymentId);
      assert.match(settledA.location, /state=success/);

      const b = await startPayment(second.link.token);
      ctx.gateway.forceTrxId(b.paymentId, duplicateTrx);
      const settledB = await callback(b.anon, second.link.token, b.paymentId);
      assert.match(settledB.location, /state=failed/);

      const paymentB = await ctx.query('select id, status, failure_reason from payments where gateway_payment_id = $1', [b.paymentId]);
      assert.equal(paymentB.rows[0].status, 'FAILED');
      assert.match(paymentB.rows[0].failure_reason, /Duplicate trxId/);

      const instB = await ctx.query('select status from installments where id = $1', [second.installment.id]);
      assert.equal(instB.rows[0].status, 'PENDING');

      const holders = await ctx.query('select count(*)::int as count from payments where trx_id = $1', [duplicateTrx]);
      assert.equal(holders.rows[0].count, 1, 'only the first payment may hold the trxId');

      const audit = await ctx.query(
        `select count(*)::int as count from audit_logs where action = 'PAYMENT_FAILED' and entity_id = $1`,
        [String(paymentB.rows[0].id)],
      );
      assert.equal(audit.rows[0].count, 1, 'the duplicate attempt must be recorded as failed');
    });

    // The database enforces it too, even if the service is bypassed.
    await assert.rejects(
      ctx.query(
        `insert into payments (installment_id, gateway, trx_id, invoice_number, amount, status, method, gateway_status)
         select installment_id, gateway, trx_id, invoice_number, amount, 'SUCCESS', method, gateway_status
           from payments where trx_id = $1`,
        [duplicateTrx],
      ),
      /already exists|duplicate key|unique/i,
    );
  });

  test('starting a payment on a settled installment is refused', async () => {
    const { link } = await createPayable();
    const { anon, paymentId } = await startPayment(link.token);
    await callback(anon, link.token, paymentId);

    const again = await anon.post(`/api/public/pay/${link.token}/start`);
    assert.equal(again.status, 409);
    assert.equal(again.error.code, 'CONFLICT');
    assert.match(again.error.message, /already paid/i);
  });

  test('a cancelled checkout leaves the installment unpaid and retryable', async () => {
    const { installment, link } = await createPayable();
    await withOutcome('cancel', async () => {
      const { anon, paymentId } = await startPayment(link.token);
      const result = await callback(anon, link.token, paymentId);
      assert.match(result.location, /state=cancelled/);

      const payment = await ctx.query('select status from payments where gateway_payment_id = $1', [paymentId]);
      assert.equal(payment.rows[0].status, 'CANCELLED');
      const inst = await ctx.query('select status from installments where id = $1', [installment.id]);
      assert.equal(inst.rows[0].status, 'PENDING');
    });

    // Retry works: the cancelled attempt does not poison the installment.
    const retry = await makeClient(ctx.baseUrl).post(`/api/public/pay/${link.token}/start`);
    assert.equal(retry.status, 200);
  });

  test('verifying an unknown payment id is a safe 404', async () => {
    const { link } = await createPayable();
    const anon = makeClient(ctx.baseUrl);
    const response = await anon.post(`/api/public/pay/${link.token}/verify`, { paymentId: 'TR_UNKNOWN_123' });
    assert.equal(response.status, 404);
  });

  test('reconciliation settles a payment whose callback was lost', async () => {
    // (a) still pending at the gateway -> the attempt stays open, nothing settles
    await withOutcome('pending', async () => {
      const { installment, link } = await createPayable();
      const { paymentId } = await startPayment(link.token);
      const row = await ctx.query('select id, status from payments where gateway_payment_id = $1', [paymentId]);
      await backdatePayment(row.rows[0].id);

      const { runJobByName } = await import('../src/jobs/scheduler.js');
      const result = await runJobByName('payments.reconcile');
      assert.equal(result.ok, true);
      assert.ok(result.result.detail.checked >= 1);

      const after = await ctx.query('select status from payments where gateway_payment_id = $1', [paymentId]);
      assert.ok(['INITIATED', 'PENDING'].includes(after.rows[0].status));
      const inst = await ctx.query('select status from installments where id = $1', [installment.id]);
      assert.equal(inst.rows[0].status, 'PENDING');
    });

    // (b) completed at the gateway but our callback never arrived -> settled
    await withOutcome('success', async () => {
      const { installment, link } = await createPayable();
      const { paymentId } = await startPayment(link.token);
      const row = await ctx.query('select id from payments where gateway_payment_id = $1', [paymentId]);
      ctx.gateway.completeAtGateway(paymentId);
      await backdatePayment(row.rows[0].id);

      const { runJobByName } = await import('../src/jobs/scheduler.js');
      const result = await runJobByName('payments.reconcile');
      assert.equal(result.ok, true);

      const payment = await ctx.query('select status, trx_id from payments where gateway_payment_id = $1', [paymentId]);
      assert.equal(payment.rows[0].status, 'SUCCESS');
      assert.ok(payment.rows[0].trx_id);
      const inst = await ctx.query('select status, paid_at, amount_paid from installments where id = $1', [installment.id]);
      assert.equal(inst.rows[0].status, 'PAID');
      assert.ok(inst.rows[0].paid_at);
      assert.equal(Number(inst.rows[0].amount_paid), installment.amount);
    });
  });
});

describe('manual payments', () => {
  test('requires a reference number', async () => {
    const { installment } = await createPayable();
    const response = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: installment.amount,
      method: 'CASH',
    });
    assert.equal(response.status, 422);
    assert.ok(response.error.details.reference);
  });

  test('records a cash payment and settles the installment', async () => {
    const { installment } = await createPayable();
    const created = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: installment.amount,
      method: 'CASH',
      reference: 'CASH-BOOK-88',
      note: 'paid at the office counter',
      notify: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.payment.status, 'SUCCESS');
    assert.equal(created.data.payment.method, 'CASH');
    assert.match(created.data.receiptNumber, /^RCPT-\d{4}-\d{6}$/);

    const inst = await ctx.query('select status, paid_at from installments where id = $1', [installment.id]);
    assert.equal(inst.rows[0].status, 'PAID');
    assert.ok(inst.rows[0].paid_at);

    const audit = await ctx.query(
      `select count(*)::int as count from audit_logs where action = 'PAYMENT_MANUAL_RECORDED' and entity_id = $1`,
      [String(created.data.payment.id)],
    );
    assert.equal(audit.rows[0].count, 1);
  });

  test('refuses an identical duplicate and an overpayment', async () => {
    const { installment } = await createPayable();
    const first = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: installment.amount,
      method: 'BANK',
      reference: 'BANK-SLIP-1',
    });
    assert.equal(first.status, 201);

    const dupe = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: installment.amount,
      method: 'BANK',
      reference: 'BANK-SLIP-1',
    });
    assert.equal(dupe.status, 409);

    const other = await createPayable();
    const overpay = await accountant.post('/api/payments/manual', {
      installmentId: other.installment.id,
      amountPoisha: other.installment.amount + 5000,
      method: 'CASH',
      reference: 'CASH-OVER-1',
    });
    assert.equal(overpay.status, 400);
    assert.equal(Number(overpay.error.details.outstanding), other.installment.amount);
  });

  test('refuses to pay a cancelled installment', async () => {
    const { installment } = await createPayable();
    await accountant.post(`/api/installments/${installment.id}/state`, { status: 'CANCELLED', reason: 'contract changed' });
    const response = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: installment.amount,
      method: 'CASH',
      reference: 'CASH-CANCELLED-1',
    });
    assert.equal(response.status, 409);
  });

  test('a partial payment stays open and tracks the amount paid', async () => {
    const { installment } = await createPayable();
    const half = Math.floor(installment.amount / 2);
    const created = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: half,
      method: 'OTHER',
      reference: 'PARTIAL-1',
      note: 'first half paid',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.payment.status, 'SUCCESS');

    const inst = await ctx.query('select status, amount_paid from installments where id = $1', [installment.id]);
    assert.equal(inst.rows[0].status, 'PARTIALLY_PAID');
    assert.equal(Number(inst.rows[0].amount_paid), half);
  });

  test('payments list, receipts and cancellation', async () => {
    const { installment } = await createPayable();
    const created = await accountant.post('/api/payments/manual', {
      installmentId: installment.id,
      amountPoisha: installment.amount,
      method: 'BANK',
      reference: 'BANK-TRF-9001',
      note: 'bank transfer',
    });
    const paymentId = created.data.payment.id;

    const list = await accountant.get('/api/payments?method=BANK&limit=10');
    assert.equal(list.status, 200);
    assert.ok(list.data.items.some((row) => row.id === paymentId));
    assert.ok(list.data.meta.total >= 1);
    assert.ok(Number(list.data.successAmount) >= installment.amount);

    const receipt = await accountant.get(`/api/payments/${paymentId}/receipt`);
    assert.equal(receipt.status, 200);
    assert.match(receipt.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(receipt.text.includes(created.data.receiptNumber));
    assert.ok(receipt.text.includes('BANK-TRF-9001'));

    const receiptJson = await accountant.get(`/api/payments/${paymentId}/receipt.json`);
    assert.equal(receiptJson.status, 200);
    assert.equal(receiptJson.data.receiptNumber, created.data.receiptNumber);
    assert.equal(receiptJson.data.manualReference, 'BANK-TRF-9001');

    const audit = await ctx.query(
      `select count(*)::int as count from audit_logs where action = 'RECEIPT_VIEWED' and entity_id = $1`,
      [created.data.receiptNumber],
    );
    assert.ok(audit.rows[0].count >= 1);

    const cancelled = await accountant.post(`/api/payments/${paymentId}/cancel`, { reason: 'bank reversed the transfer' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.payment.status, 'CANCELLED');

    const inst = await ctx.query('select status, amount_paid from installments where id = $1', [installment.id]);
    assert.equal(inst.rows[0].status, 'PENDING');
    assert.equal(Number(inst.rows[0].amount_paid), 0);

    const cancelAudit = await ctx.query(
      `select count(*)::int as count from audit_logs where action = 'PAYMENT_CANCELLED' and entity_id = $1`,
      [String(paymentId)],
    );
    assert.equal(cancelAudit.rows[0].count, 1);
  });
});

describe('SMS', () => {
  test('sending a payment link records the message and its masked log entry', async () => {
    const { installment } = await createPayable({ name: 'Kabir Ahmed' });
    const response = await accountant.post(`/api/installments/${installment.id}/send-link`, {});
    assert.equal(response.status, 200);
    assert.equal(response.data.sent, true);
    assert.match(response.data.url, /\/pay\//);

    const log = await ctx.query('select * from sms_logs order by id desc limit 1');
    assert.equal(log.rows[0].message_type, 'PAYMENT_LINK');
    assert.equal(log.rows[0].provider_status, 'SENT');
    assert.match(log.rows[0].mobile_masked, /^0171\*+77$|^\d{4}\*+\d{2}$/);
    assert.ok(!log.rows[0].body_preview.includes('Kabir Ahmed'), 'the stored preview must not contain the full name');
    assert.ok(log.rows[0].body_preview.includes('/pay/'), 'the SMS carries the payment link');

    const captured = ctx.smsProvider.sent.at(-1);
    assert.equal(captured.messageType, 'PAYMENT_LINK');
    assert.equal(Number(captured.installmentId), Number(installment.id));

    const audit = await ctx.query(`select count(*)::int as count from audit_logs where action = 'SMS_SENT'`);
    assert.ok(audit.rows[0].count >= 1);
  });

  test('bulk send is capped at 50 and reports per-installment results', async () => {
    const { installment } = await createPayable();
    const bulk = await accountant.post('/api/installments/bulk/send-links', { ids: [installment.id, installment.id] });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.data.requested, 2);
    assert.equal(bulk.data.sent, 2);

    const tooMany = await accountant.post('/api/installments/bulk/send-links', {
      ids: Array.from({ length: 51 }, (_, index) => index + 1),
    });
    assert.equal(tooMany.status, 400);

    const empty = await accountant.post('/api/installments/bulk/send-links', { ids: [] });
    assert.equal(empty.status, 400);
  });

  test('a provider outage is recorded without breaking the request', async () => {
    const { installment } = await createPayable();
    ctx.smsProvider.failNext('carrier outage');
    const response = await accountant.post(`/api/installments/${installment.id}/send-link`, {});
    assert.equal(response.status, 200);
    assert.equal(response.data.sent, false);
    assert.match(response.data.sms.error, /carrier outage/);

    const log = await ctx.query('select * from sms_logs order by id desc limit 1');
    assert.equal(log.rows[0].provider_status, 'FAILED');
    assert.match(log.rows[0].error, /carrier outage/);

    const audit = await ctx.query(`select count(*)::int as count from audit_logs where action = 'SMS_FAILED'`);
    assert.ok(audit.rows[0].count >= 1);
  });
});

describe('dashboard and reports', () => {
  test('the dashboard reflects settled money', async () => {
    const { link } = await createPayable({ totalTaka: '4500.00' });
    const { anon, paymentId } = await startPayment(link.token);
    await callback(anon, link.token, paymentId);

    const response = await accountant.get('/api/dashboard');
    assert.equal(response.status, 200);
    assert.ok(response.data.kpis.totalInvested > 0);
    assert.ok(response.data.kpis.totalCollected > 0);
    assert.ok(Array.isArray(response.data.collectionsByMonth));
    assert.ok(Array.isArray(response.data.installmentsByStatus));
    assert.equal(response.data.timeZone, 'Asia/Dhaka');
  });

  test('collections report (JSON + CSV) and due/overdue reports', async () => {
    const collections = await accountant.get('/api/reports/collections?months=6');
    assert.equal(collections.status, 200);
    assert.equal(collections.data.months.length, 6);
    assert.ok(collections.data.total > 0);
    assert.ok(collections.data.months.every((row) => /^\d{4}-\d{2}$/.test(row.month)));

    const csv = await accountant.get('/api/reports/collections.csv?months=6');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.equal(csv.headers.get('content-disposition')?.includes('attachment'), true);
    assert.match(csv.text.split('\r\n')[0], /Month|month/);

    const due = await accountant.get('/api/reports/due?from=2020-01-01&to=2030-12-31');
    assert.equal(due.status, 200);
    assert.ok(due.data.summary.count >= 1);
    assert.ok(Array.isArray(due.data.rows));

    const dueCsv = await accountant.get('/api/reports/due.csv?from=2020-01-01&to=2030-12-31');
    assert.equal(dueCsv.status, 200);
    assert.ok(dueCsv.text.split('\r\n').length >= 2);

    const overdue = await accountant.get('/api/reports/overdue');
    assert.equal(overdue.status, 200);
    assert.ok(typeof overdue.data.summary.outstanding === 'number');
    assert.ok(overdue.data.summary.buckets);

    const print = await accountant.get('/api/reports/due.html?from=2020-01-01&to=2030-12-31');
    assert.equal(print.status, 200);
    assert.match(print.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(print.text.includes('@media print'));

    const today = await accountant.get('/api/reports/today');
    assert.equal(today.status, 200);
    assert.ok(typeof today.data.todayCollection === 'number');

    const audit = await ctx.query(`select count(*)::int as count from audit_logs where action = 'REPORT_EXPORTED'`);
    assert.ok(audit.rows[0].count >= 1);
  });

  test('an investor statement is generated as JSON, CSV and printable HTML', async () => {
    const { investor } = await createPayable();
    const json = await accountant.get(`/api/reports/investors/${investor.id}/statement`);
    assert.equal(json.status, 200);

    const csv = await accountant.get(`/api/reports/investors/${investor.id}/statement.csv`);
    assert.equal(csv.status, 200);
    assert.ok(csv.text.length > 0);

    const html = await accountant.get(`/api/reports/investors/${investor.id}/statement.html`);
    assert.equal(html.status, 200);
    assert.ok(html.text.includes(investor.name));
  });
});

describe('jobs', () => {
  test('run-now executes a job, records the run and rejects unknown names', async () => {
    const jobs = await admin.get('/api/jobs');
    assert.equal(jobs.status, 200);
    assert.equal(jobs.data.enabled, false, 'the scheduler is disabled in tests');
    assert.ok(jobs.data.jobs.some((job) => job.name === 'installments.overdue'));

    const run = await admin.post('/api/jobs/installments.overdue/run', {});
    assert.equal(run.status, 200);
    assert.equal(run.data.ok, true);

    const runRow = await ctx.query(`select status from job_runs where job_name = 'installments.overdue' order by id desc limit 1`);
    assert.equal(runRow.rows[0].status, 'SUCCESS');

    const unknown = await admin.post('/api/jobs/nope/run', {});
    assert.equal(unknown.data.ok, false);
    assert.match(unknown.data.error, /Unknown job/);
  });

  test('reminders send once per window and respect the anti-spam guard', async () => {
    const { installment, investment } = await createPayable({ name: 'Reminder Target' });
    const { dhakaDate, addDays } = await import('../src/utils/dates.js');
    await ctx.query('update installments set due_date = $1 where id = $2', [addDays(dhakaDate(), 3), installment.id]);

    const { runJobByName } = await import('../src/jobs/scheduler.js');
    const first = await runJobByName('reminders.sms');
    assert.equal(first.ok, true);
    assert.ok(first.result.itemsProcessed >= 1);

    const sent = ctx.smsProvider.sent.filter(
      (message) => message.messageType === 'DUE_REMINDER' && Number(message.installmentId) === Number(installment.id),
    );
    assert.equal(sent.length, 1);

    const reminded = await ctx.query('select last_reminded_at, reminder_count from installments where id = $1', [installment.id]);
    assert.ok(reminded.rows[0].last_reminded_at);
    assert.ok(Number(reminded.rows[0].reminder_count) >= 1);

    const second = await runJobByName('reminders.sms');
    assert.equal(second.ok, true);
    const again = ctx.smsProvider.sent.filter(
      (message) => message.messageType === 'DUE_REMINDER' && Number(message.installmentId) === Number(installment.id),
    );
    assert.equal(again.length, 1, 'the same installment must not be reminded twice inside the throttle window');

    const log = await ctx.query(`select count(*)::int as count from sms_logs where installment_id = $1 and message_type = 'DUE_REMINDER'`, [
      installment.id,
    ]);
    assert.equal(log.rows[0].count, 1);
    assert.ok(investment.id);
  });

  test('job failures are captured, never thrown at the caller', async () => {
    const { runJobByName } = await import('../src/jobs/scheduler.js');
    const result = await runJobByName('does-not-exist');
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});
