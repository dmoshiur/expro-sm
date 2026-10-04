/**
 * Phase 5 - bKash checkout, settlement, receipts, reconciliation, manual payments.
 *
 * The gateway is the deterministic mock adapter; every scenario is scripted by
 * `mockGatewayControl` so no network access is required.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { consoleOutbox } from '../src/services/sms/providers/console.provider';
import { mockGatewayControl } from '../src/services/payment/gateway/mock.gateway';
import { reconcileStalePayments } from '../src/services/payment/payment.service';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

const firstDue = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 3));

async function setup(options: { installments?: number; totalAmount?: string } = {}) {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  const client = (await loginWith({ email: 'super@test.local' })).client;

  const investor = await client
    .post('/api/investors')
    .send({ name: 'Karim Ahmed', mobile: '01812345678', nid: '1995123456789' })
    .expect(201);

  const count = options.installments ?? 2;
  const investment = await client
    .post('/api/investments')
    .send({
      investorId: investor.body.investor.id,
      totalAmount: options.totalAmount ?? '2000',
      installmentCount: count,
      firstDueDate: firstDue,
      interval: { unit: 'MONTH', value: 1 },
    })
    .expect(201);

  return {
    client,
    investorId: investor.body.investor.id as string,
    investmentId: investment.body.investment.id as string,
    installments: investment.body.investment.installments as Array<{ id: string; serial: number; amount: string }>,
  };
}

function tokenFromLastSms(): string {
  const last = consoleOutbox.last();
  if (!last) throw new Error('no SMS was sent');
  const match = /\/pay\/([A-Za-z0-9_-]+)/.exec(last.body);
  if (!match) throw new Error(`no payment link in SMS: ${last.body}`);
  return match[1]!;
}

/** Sends the link, opens the gateway session and returns everything we need. */
async function openSession(client: Awaited<ReturnType<typeof setup>>['client'], installmentId: string) {
  await client.post(`/api/payments/installments/${installmentId}/link/send`).expect(200);
  const token = tokenFromLastSms();
  const start = await request(app).post(`/api/public/payments/${token}/start`).expect(200);
  return { token, start: start.body as { paymentId: string; gatewayPaymentId: string; amount: string; redirectUrl: string } };
}

const callbackUrl = (gatewayPaymentId: string, status: string) =>
  `/api/public/payments/bkash/callback?paymentID=${gatewayPaymentId}&status=${status}`;

describe('payment links and bKash checkout', () => {
  beforeEach(async () => {
    await truncateAll();
    consoleOutbox.clear();
    mockGatewayControl.reset();
  });

  it('never exposes an amount that is not from the database and marks the session PENDING', async () => {
    const { client, installments } = await setup();
    const { token, start } = await openSession(client, installments[0]!.id);

    const payment = await prisma.payment.findUnique({ where: { id: start.paymentId } });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('PENDING');
    expect(payment!.amount.toString()).toBe('100000'); // 2000 BDT / 2 = 100000 poisha
    expect(payment!.gatewayPaymentId).toBe(start.gatewayPaymentId);
    expect(start.redirectUrl).toContain('paymentID=');

    // The public page shows the real amount and nothing else about the investor.
    const details = await request(app).get(`/api/public/payments/${token}`).expect(200);
    expect(details.body.amount).toBe('100000');
    expect(details.body.firstName).toBe('Karim');
    expect(JSON.stringify(details.body)).not.toContain('01812345678');
  });

  it('settles a completed payment: SUCCESS + receipt number + installment PAID + token revoked', async () => {
    const { client, installments } = await setup();
    const { token, start } = await openSession(client, installments[0]!.id);

    const response = await request(app).get(callbackUrl(start.gatewayPaymentId, 'success')).expect(303);
    expect(response.headers.location).toContain('status=success');

    const payment = await prisma.payment.findUnique({ where: { id: start.paymentId } });
    expect(payment!.status).toBe('SUCCESS');
    expect(payment!.receiptNumber).toMatch(/^RC-\d{6}-[0-9A-F]{6}$/);
    expect(payment!.trxId).toBeTruthy();
    expect(payment!.completedAt).not.toBeNull();

    const installment = await prisma.installment.findUnique({ where: { id: installments[0]!.id } });
    expect(installment!.status).toBe('PAID');
    expect(installment!.paidAmount.toString()).toBe('100000');
    expect(installment!.payTokenHash).toBeNull();

    // the old link is dead now
    await request(app).get(`/api/public/payments/${token}`).expect(404);
    const rows = await auditRows(AuditAction.PAYMENT_SUCCEEDED);
    expect(rows.length).toBe(1);
  });

  it('is idempotent for a duplicated callback', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);

    await request(app).get(callbackUrl(start.gatewayPaymentId, 'success')).expect(303);
    await request(app).get(callbackUrl(start.gatewayPaymentId, 'success')).expect(303);

    const installment = await prisma.installment.findUnique({ where: { id: installments[0]!.id } });
    expect(installment!.paidAmount.toString()).toBe('100000');
    expect(await prisma.payment.count({ where: { installmentId: installments[0]!.id, status: 'SUCCESS' } })).toBe(1);
    expect((await auditRows(AuditAction.PAYMENT_SUCCEEDED)).length).toBe(1);
  });

  it('rejects a replayed gateway transaction id instead of double crediting', async () => {
    const { client, installments } = await setup({ installments: 2 });
    const first = await openSession(client, installments[0]!.id);
    const second = await openSession(client, installments[1]!.id);

    const shared = mockGatewayControl.get(first.start.gatewayPaymentId)!;
    shared.trxId = 'DUPLICATED-TRX-001'; // the store is mutated by reference
    shared.status = 'Completed';

    await request(app).get(callbackUrl(first.start.gatewayPaymentId, 'success')).expect(303);

    const other = mockGatewayControl.get(second.start.gatewayPaymentId)!;
    other.trxId = 'DUPLICATED-TRX-001';
    other.status = 'Completed';
    const response = await request(app).get(callbackUrl(second.start.gatewayPaymentId, 'success')).expect(303);
    expect(response.headers.location).toContain('status=failed');

    const payment = await prisma.payment.findUnique({ where: { id: second.start.paymentId } });
    expect(payment!.status).toBe('FAILED');
    expect(payment!.failureReason).toContain('Duplicate gateway transaction id');

    // the second installment was NOT credited
    const installment = await prisma.installment.findUnique({ where: { id: installments[1]!.id } });
    expect(installment!.paidAmount.toString()).toBe('0');
    expect(installment!.status).not.toBe('PAID');
  });

  it('marks cancelled and failed payments without touching the installment', async () => {
    const { client, installments } = await setup();

    const cancelled = await openSession(client, installments[0]!.id);
    await request(app).get(callbackUrl(cancelled.start.gatewayPaymentId, 'cancel')).expect(303);
    const cancelledRow = await prisma.payment.findUnique({ where: { id: cancelled.start.paymentId } });
    expect(cancelledRow!.status).toBe('CANCELLED');
    expect((await prisma.installment.findUnique({ where: { id: installments[0]!.id } }))!.paidAmount.toString()).toBe('0');
    expect((await auditRows(AuditAction.PAYMENT_CANCELLED)).length).toBe(1);

    mockGatewayControl.setOutcome('failed');
    const failed = await openSession(client, installments[0]!.id);
    await request(app).get(callbackUrl(failed.start.gatewayPaymentId, 'failure')).expect(303);
    const failedRow = await prisma.payment.findUnique({ where: { id: failed.start.paymentId } });
    expect(failedRow!.status).toBe('FAILED');
    expect((await paginatedAudit(AuditAction.PAYMENT_FAILED)).length).toBe(1);
  });

  it('refuses to settle when the gateway reports a different amount', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);
    mockGatewayControl.setReportedAmount(5000n); // 50 BDT instead of 1000 BDT

    await request(app).get(callbackUrl(start.gatewayPaymentId, 'success')).expect(303);
    const payment = await prisma.payment.findUnique({ where: { id: start.paymentId } });
    expect(payment!.status).toBe('FAILED');
    expect(payment!.failureReason).toContain('Amount mismatch');
    expect((await prisma.installment.findUnique({ where: { id: installments[0]!.id } }))!.paidAmount.toString()).toBe('0');
  });

  it('rejects a start request for an unknown or expired link', async () => {
    await setup();
    await request(app).post('/api/public/payments/not-a-real-token-abcdefghijklmnop/start').expect(404);
  });

  it('refuses to start a payment once the installment is paid (link is retired)', async () => {
    const { client, installments } = await setup();
    const { token, start } = await openSession(client, installments[0]!.id);
    await request(app).get(callbackUrl(start.gatewayPaymentId, 'success')).expect(303);

    // settling a fully paid installment clears the token, so the link is gone
    const response = await request(app).post(`/api/public/payments/${token}/start`).expect(404);
    expect(response.body.error.message).toMatch(/invalid or has expired/i);
  });

  it('resumes the same gateway session on a double click instead of creating a second one', async () => {
    const { client, installments } = await setup();
    const { token, start } = await openSession(client, installments[0]!.id);

    const again = await request(app).post(`/api/public/payments/${token}/start`).expect(200);
    expect(again.body.paymentId).toBe(start.paymentId);
    expect(again.body.redirectUrl).toBe(start.redirectUrl);
    expect(await prisma.payment.count({ where: { installmentId: installments[0]!.id } })).toBe(1);
  });

  it('reconciles a stuck payment that the gateway says is completed', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);

    // the investor authorised at bKash but never came back to our callback
    mockGatewayControl.authorise(start.gatewayPaymentId, 'completed');
    await prisma.payment.update({
      where: { id: start.paymentId },
      data: { createdAt: new Date(Date.now() - 30 * 60_000) },
    });

    const summary = await reconcileStalePayments({ olderThanMinutes: 10 });
    expect(summary.checked).toBe(1);
    expect(summary.settled).toBe(1);

    const installment = await prisma.installment.findUnique({ where: { id: installments[0]!.id } });
    expect(installment!.status).toBe('PAID');
    expect((await auditRows(AuditAction.PAYMENT_RECONCILED)).length).toBe(1);
  });

  it('reconciles a stale payment the gateway failed', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);
    mockGatewayControl.authorise(start.gatewayPaymentId, 'failed');
    await prisma.payment.update({ where: { id: start.paymentId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });

    const summary = await reconcileStalePayments({ olderThanMinutes: 10 });
    expect(summary.failed).toBe(1);
    expect((await prisma.payment.findUnique({ where: { id: start.paymentId } }))!.status).toBe('FAILED');
  });

  it('rejects a stale payment whose reported amount is wrong', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);
    // the gateway acknowledged more/less money than the installment asked for
    mockGatewayControl.authorise(start.gatewayPaymentId, 'amount_mismatch');
    await prisma.payment.update({ where: { id: start.paymentId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });

    const summary = await reconcileStalePayments({ olderThanMinutes: 10 });
    expect(summary.failed).toBe(1);
    expect((await prisma.payment.findUnique({ where: { id: start.paymentId } }))!.failureReason).toContain('Amount mismatch');
  });

  it('ignores a webhook while webhooks are disabled', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);
    await request(app)
      .post('/api/public/payments/bkash/webhook')
      .send({ paymentID: start.gatewayPaymentId, transactionStatus: 'Completed' })
      .expect(202);
    expect((await prisma.payment.findUnique({ where: { id: start.paymentId } }))!.status).toBe('PENDING');
  });
});

describe('manual payments and receipts', () => {
  beforeEach(async () => {
    await truncateAll();
    consoleOutbox.clear();
    mockGatewayControl.reset();
  });

  it('records a partial manual payment and issues a receipt number', async () => {
    const { client, installments } = await setup();
    const response = await client
      .post(`/api/payments/installments/${installments[0]!.id}/manual`)
      .send({ amount: '400', method: 'BANK', reference: 'SLIP-99321', note: 'bKash agent deposit' })
      .expect(201);

    expect(response.body.receiptNumber).toMatch(/^RC-/);
    expect(response.body.status).toBe('PARTIALLY_PAID');

    const payment = await prisma.payment.findUnique({ where: { id: response.body.paymentId } });
    expect(payment!.method).toBe('BANK');
    expect(payment!.gateway).toBe('MANUAL');
    expect(payment!.amount.toString()).toBe('40000');
    expect(payment!.recordedByAdminId).toBeTruthy();
    expect((await prisma.installment.findUnique({ where: { id: installments[0]!.id } }))!.paidAmount.toString()).toBe('40000');
    expect((await auditRows(AuditAction.PAYMENT_MANUAL_RECORDED)).length).toBe(1);
  });

  it('requires a reference and refuses to overpay an installment', async () => {
    const { client, installments } = await setup();
    await client
      .post(`/api/payments/installments/${installments[0]!.id}/manual`)
      .send({ method: 'CASH', reference: 'x' })
      .expect(400);
    const response = await client
      .post(`/api/payments/installments/${installments[0]!.id}/manual`)
      .send({ amount: '5000', method: 'CASH', reference: 'SLIP-1' })
      .expect(422);
    expect(response.body.error.message).toMatch(/exceeds/i);
  });

  it('lets an accountant record a manual payment but not a viewer', async () => {
    const ctx = await setup();
    await createTestAdmin({ email: 'accountant@test.local', role: 'ACCOUNTANT' });
    await createTestAdmin({ email: 'viewer@test.local', role: 'VIEWER' });

    const accountant = (await loginWith({ email: 'accountant@test.local' })).client;
    const viewer = (await loginWith({ email: 'viewer@test.local' })).client;

    await accountant
      .post(`/api/payments/installments/${ctx.installments[0]!.id}/manual`)
      .send({ method: 'CASH', reference: 'SLIP-ACCT-1' })
      .expect(201);

    await viewer
      .post(`/api/payments/installments/${ctx.installments[1]!.id}/manual`)
      .send({ method: 'CASH', reference: 'SLIP-VIEW-1' })
      .expect(403);

    // viewers may read payments
    await viewer.get('/api/payments').expect(200);
  });

  it('streams a PDF receipt for a successful payment and audits the download', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);
    await request(app).get(callbackUrl(start.gatewayPaymentId, 'success')).expect(303);

    const response = await client
      .get(`/api/payments/${start.paymentId}/receipt.pdf`)
      .set('Accept', 'application/pdf')
      .expect(200);

    expect(response.headers['content-type']).toContain('application/pdf');
    const buffer = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? '', 'binary');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');

    const rows = await auditRows(AuditAction.RECEIPT_DOWNLOADED);
    expect(rows.length).toBe(1);
  });

  it('refuses a receipt for a payment that did not succeed', async () => {
    const { client, installments } = await setup();
    const { start } = await openSession(client, installments[0]!.id);
    await client.get(`/api/payments/${start.paymentId}/receipt.pdf`).expect(409);
  });

  it('lists payments with filters and pagination', async () => {
    const { client, installments } = await setup();
    await client
      .post(`/api/payments/installments/${installments[0]!.id}/manual`)
      .send({ method: 'CASH', reference: 'SLIP-777' })
      .expect(201);

    const list = await client.get('/api/payments?method=CASH&search=SLIP-777').expect(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].receiptNumber).toMatch(/^RC-/);

    const empty = await client.get('/api/payments?method=BKASH').expect(200);
    expect(empty.body.items.length).toBe(0);

    await client.get('/api/payments?status=BOGUS').expect(400);
  });

  it('returns payment detail with the installment attached', async () => {
    const { client, installments } = await setup();
    const created = await client
      .post(`/api/payments/installments/${installments[0]!.id}/manual`)
      .send({ method: 'CASH', reference: 'SLIP-888' })
      .expect(201);

    const detail = await client.get(`/api/payments/${created.body.paymentId}`).expect(200);
    expect(detail.body.payment.installment.id).toBe(installments[0]!.id);
    expect(detail.body.payment.amount).toBe('100000');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------


async function paginatedAudit(action: string) {
  return auditRows(action);
}
