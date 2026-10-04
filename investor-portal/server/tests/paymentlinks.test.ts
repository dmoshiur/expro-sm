import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { AuditAction } from '../src/utils/auditActions';
import { sha256 } from '../src/utils/encryption';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { consoleOutbox } from '../src/services/sms/providers/console.provider';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

const firstDue = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 3));

async function setup() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  const client = (await loginWith({ email: 'super@test.local' })).client;
  const investor = await client
    .post('/api/investors')
    .send({ name: 'Rahim Uddin', mobile: '01712345678', nid: '1990123456789' })
    .expect(201);
  const investment = await client
    .post('/api/investments')
    .send({
      investorId: investor.body.investor.id,
      totalAmount: '3000',
      installmentCount: 3,
      firstDueDate: firstDue,
      interval: { unit: 'MONTH', value: 1 },
    })
    .expect(201);
  return {
    client,
    investorId: investor.body.investor.id as string,
    investmentId: investment.body.investment.id as string,
    installments: investment.body.investment.installments as Array<{ id: string; serial: number }>,
  };
}

/** Extracts the token from the URL captured by the console SMS provider. */
function tokenFromLastSms(): string {
  const last = consoleOutbox.last();
  if (!last) throw new Error('no SMS was sent');
  const match = /\/pay\/([A-Za-z0-9_-]+)/.exec(last.body);
  if (!match) throw new Error(`no payment link in SMS: ${last.body}`);
  return match[1]!;
}

describe('payment links', () => {
  beforeEach(async () => {
    await truncateAll();
    consoleOutbox.clear();
  });

  it('sends a link by SMS, stores only the hash and exposes minimal public data', async () => {
    const { client, installments } = await setup();
    const response = await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);

    expect(response.body.sms.success).toBe(true);
    const token = tokenFromLastSms();
    expect(token.length).toBeGreaterThanOrEqual(40);

    const row = await prisma.installment.findUnique({ where: { id: installments[0]!.id } });
    expect(row!.payTokenHash).toBe(sha256(token));
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(token); // the raw token is never persisted
    expect(row!.tokenExpiresAt).toBeTruthy();
    expect(response.body.link.url).toBe(`${config.appBaseUrl}/pay/${token}`);

    const smsLog = await prisma.smsLog.findFirst({ where: { installmentId: installments[0]!.id } });
    expect(smsLog?.status).toBe('SENT');
    expect(smsLog?.purpose).toBe('PAYMENT_LINK');
    expect(smsLog?.toMobile).toBe('01712345678');
    expect(smsLog?.body).toContain('/pay/');

    // public payload: first name only, no NID, no full mobile
    const publicView = await request(app).get(`/api/public/payments/${token}`).expect(200);
    expect(publicView.body).toMatchObject({
      firstName: 'Rahim',
      installmentSerial: 1,
      installmentCount: 3,
      dueDate: firstDue,
      status: 'PENDING',
    });
    expect(publicView.body.amount).toBe('100000');
    expect(publicView.body.amountLabel).toContain('1,000');
    const raw = JSON.stringify(publicView.body);
    expect(raw).not.toContain('1990123456789');
    expect(raw).not.toContain('01712345678');
    expect(raw).not.toMatch(/Uddin/);
    expect(raw).not.toContain(installments[0]!.id);

    expect(await auditRows(AuditAction.PAYMENT_LINK_SENT)).toHaveLength(1);
  });

  it('rejects unknown, malformed and expired tokens with the same generic error', async () => {
    const { client, installments } = await setup();
    await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);
    const token = tokenFromLastSms();

    const unknown = await request(app).get(`/api/public/payments/${'a'.repeat(43)}`).expect(404);
    const malformed = await request(app).get('/api/public/payments/short').expect(404);
    expect(unknown.body.error.message).toBe(malformed.body.error.message);

    // expire the link
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { tokenExpiresAt: addDhakaDays(new Date(), -1) },
    });
    const expired = await request(app).get(`/api/public/payments/${token}`).expect(404);
    expect(expired.body.error.message).toBe(unknown.body.error.message);
  });

  it('invalidates the previous link when regenerating', async () => {
    const { client, installments } = await setup();
    await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);
    const firstToken = tokenFromLastSms();

    const regenerated = await client
      .post(`/api/payments/installments/${installments[0]!.id}/link/regenerate`)
      .send({})
      .expect(200);
    const newToken = regenerated.body.link.url.split('/pay/')[1];

    await request(app).get(`/api/public/payments/${newToken}`).expect(200);
    await request(app).get(`/api/public/payments/${firstToken}`).expect(404);

    const audits = await auditRows(AuditAction.PAYMENT_LINK_REGENERATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(installments[0]!.id);
  });

  it('stops serving links for paid, waived or cancelled installments', async () => {
    const { client, installments } = await setup();
    await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);
    const token = tokenFromLastSms();

    await client
      .post(`/api/installments/${installments[0]!.id}/waive`)
      .send({ reason: 'waived for the test' })
      .expect(200);

    await request(app).get(`/api/public/payments/${token}`).expect(404);
    const sendAgain = await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(409);
    expect(sendAgain.body.error.message).toMatch(/waived/i);
  });

  it('does not serve links for inactive investors or cancelled investments', async () => {
    const { client, installments, investorId, investmentId } = await setup();
    await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);
    const token = tokenFromLastSms();

    await client.post(`/api/investors/${investorId}/deactivate`).expect(200);
    await request(app).get(`/api/public/payments/${token}`).expect(404);

    await client.post(`/api/investors/${investorId}/reactivate`).expect(200);
    await request(app).get(`/api/public/payments/${token}`).expect(200);

    await client.post(`/api/investments/${investmentId}/cancel`).send({ reason: 'test cancel' }).expect(200);
    await request(app).get(`/api/public/payments/${token}`).expect(404);
  });

  it('sends links in bulk for open installments (and skips paid ones)', async () => {
    const { client, investmentId, installments } = await setup();
    await prisma.installment.update({
      where: { id: installments[2]!.id },
      data: { status: 'PAID', paidAmount: 100000n, paidAt: new Date() },
    });

    const response = await client.post(`/api/payments/investments/${investmentId}/links/send`).expect(200);
    expect(response.body.attempted).toBe(2);
    expect(response.body.sent).toBe(2);
    expect(consoleOutbox.all()).toHaveLength(2);

    expect(await auditRows(AuditAction.PAYMENT_LINK_BULK_SENT)).toHaveLength(1);
    expect(await prisma.smsLog.count({ where: { purpose: 'PAYMENT_LINK' } })).toBe(2);
  });

  it('records a failed SMS delivery instead of throwing', async () => {
    const { client, installments } = await setup();
    const { setSmsProvider } = await import('../src/services/sms/sms.service');
    setSmsProvider({
      name: 'broken-gateway',
      configured: true,
      send: async () => ({ provider: 'broken-gateway', success: false, error: 'gateway is down' }),
    });

    try {
      const response = await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);
      expect(response.body.sms.success).toBe(false);
      expect(response.body.sms.error).toMatch(/down/);

      const log = await prisma.smsLog.findFirst({ where: { installmentId: installments[0]!.id } });
      expect(log?.status).toBe('FAILED');
      expect(log?.error).toMatch(/down/);
    } finally {
      setSmsProvider(null);
    }
  });

  it('lists SMS logs with masking for non super admins', async () => {
    const { client, installments } = await setup();
    await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);

    const asSuper = await client.get('/api/payments/sms-logs').expect(200);
    expect(asSuper.body.items[0].toMobile).toBe('01712345678');

    await createTestAdmin({ email: 'accountant@test.local', role: 'ACCOUNTANT' });
    const accountant = (await loginWith({ email: 'accountant@test.local' })).client;
    const asAccountant = await accountant.get('/api/payments/sms-logs').expect(200);
    expect(asAccountant.body.items[0].toMobile).toBe('01712****78');
  });

  it('requires permission to regenerate or send links, and rate limits the public page', async () => {
    const { installments } = await setup();
    await request(app).post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(401);

    await createTestAdmin({ email: 'viewer@test.local', role: 'VIEWER' });
    const viewer = (await loginWith({ email: 'viewer@test.local' })).client;
    await viewer.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(403);
    await viewer.post(`/api/payments/installments/${installments[0]!.id}/link/regenerate`).send({}).expect(403);
  });

  it('exposes only non-secret gateway info on the public config endpoint', async () => {
    const response = await request(app).get('/api/public/config').expect(200);
    expect(response.body.gateway).toBe('bKash');
    expect(JSON.stringify(response.body)).not.toMatch(/key|secret|password/i);
  });
});
