/** Phase 6 - due/collection reports, statements and Excel/PDF exports. */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

const firstDue = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 2));

async function setup() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  const client = (await loginWith({ email: 'super@test.local' })).client;

  const investor = await client
    .post('/api/investors')
    .send({ name: 'Sabbir Rahman', mobile: '01611111111', nid: '1988123456789' })
    .expect(201);
  const investorId = investor.body.investor.id as string;

  const investment = await client
    .post('/api/investments')
    .send({
      investorId,
      totalAmount: '3000',
      installmentCount: 3,
      firstDueDate: firstDue,
      interval: { unit: 'MONTH', value: 1 },
    })
    .expect(201);

  return { client, investorId, investmentId: investment.body.investment.id as string };
}

describe('reports', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('lists the due book with totals and overdue flags', async () => {
    const { client } = await setup();
    const investment = await prisma.investment.findFirstOrThrow({ include: { installments: true } });
    await prisma.installment.update({
      where: { id: investment.installments[0]!.id },
      data: { status: 'OVERDUE', dueDate: addDhakaDays(startOfDhakaDay(), -3) },
    });

    const response = await client.get('/api/reports/due?pageSize=2').expect(200);
    expect(response.body.items.length).toBe(2);
    expect(response.body.total).toBe(3);
    expect(response.body.totals.contracted).toBe('300000');
    expect(response.body.totals.outstanding).toBe('300000');
    expect(response.body.items[0].overdue).toBe(true);
    expect(response.body.items[0].daysOverdue).toBeGreaterThanOrEqual(3);
    expect(response.body.items[0].investor.name).toBe('Sabbir Rahman');

    const overdueOnly = await client.get('/api/reports/due?overdueOnly=true').expect(200);
    expect(overdueOnly.body.total).toBe(1);
    expect(overdueOnly.body.items[0].status).toBe('OVERDUE');
  });

  it('lists collections by method with totals', async () => {
    const { client } = await setup();
    const investment = await prisma.investment.findFirstOrThrow({ include: { installments: true } });
    await client
      .post(`/api/payments/installments/${investment.installments[0]!.id}/manual`)
      .send({ amount: '1000', method: 'CASH', reference: 'CASH-10' })
      .expect(201);
    await client
      .post(`/api/payments/installments/${investment.installments[1]!.id}/manual`)
      .send({ amount: '250', method: 'BANK', reference: 'BANK-10' })
      .expect(201);

    const response = await client.get('/api/reports/collections').expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.totals.amount).toBe('125000');
    const cash = response.body.totals.byMethod.find((row: { method: string }) => row.method === 'CASH');
    expect(cash.amount).toBe('100000');

    const bankOnly = await client.get('/api/reports/collections?method=BANK').expect(200);
    expect(bankOnly.body.total).toBe(1);
    expect(bankOnly.body.items[0].amount).toBe('25000');
  });

  it('builds an investor statement with totals and payment history', async () => {
    const { client, investorId } = await setup();
    const investment = await prisma.investment.findFirstOrThrow({ include: { installments: true } });
    await client
      .post(`/api/payments/installments/${investment.installments[0]!.id}/manual`)
      .send({ amount: '1000', method: 'CASH', reference: 'CASH-20' })
      .expect(201);

    const response = await client.get(`/api/reports/investors/${investorId}/statement`).expect(200);
    expect(response.body.investor.name).toBe('Sabbir Rahman');
    expect(response.body.totals.contracted).toBe('300000');
    expect(response.body.totals.collected).toBe('100000');
    expect(response.body.totals.outstanding).toBe('200000');
    expect(response.body.payments.length).toBe(1);
    expect(response.body.payments[0].receiptNumber).toMatch(/^RC-/);
    expect(response.body.investments[0].installments.length).toBe(3);
  });

  it('exports XLSX workbooks that Excel can open', async () => {
    const { client, investorId } = await setup();
    const investment = await prisma.investment.findFirstOrThrow({ include: { installments: true } });
    await client
      .post(`/api/payments/installments/${investment.installments[0]!.id}/manual`)
      .send({ amount: '1000', method: 'CASH', reference: 'CASH-30' })
      .expect(201);

    for (const url of ['/api/reports/due.xlsx', '/api/reports/collections.xlsx', `/api/reports/investors/${investorId}/statement.xlsx`]) {
      const response = await client.get(url).expect(200);
      expect(response.headers['content-type']).toContain('spreadsheetml');
      expect(response.headers['content-disposition']).toContain('.xlsx');
      const buffer = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? '', 'binary');
      // XLSX is a ZIP container - "PK" magic bytes
      expect(buffer.subarray(0, 2).toString()).toBe('PK');
      expect(buffer.length).toBeGreaterThan(1000);
    }

    const exports = await auditRows(AuditAction.DATA_EXPORTED);
    expect(exports.length).toBe(3);
  });

  it('exports an investor statement as PDF', async () => {
    const { client, investorId } = await setup();
    const response = await client
      .get(`/api/reports/investors/${investorId}/statement.pdf`)
      .set('Accept', 'application/pdf')
      .expect(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    const buffer = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? '', 'binary');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('blocks exports for a viewer (report:read yes, report:export no)', async () => {
    const { investorId } = await setup();
    await createTestAdmin({ email: 'viewer2@test.local', role: 'VIEWER' });
    const viewer = (await loginWith({ email: 'viewer2@test.local' })).client;

    await viewer.get('/api/reports/due').expect(200);
    await viewer.get(`/api/reports/investors/${investorId}/statement`).expect(200);
    await viewer.get('/api/reports/due.xlsx').expect(403);
    await viewer.get('/api/reports/collections.xlsx').expect(403);
    await viewer.get(`/api/reports/investors/${investorId}/statement.xlsx`).expect(403);
  });

  it('requires authentication', async () => {
    await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
    const anonymous = (await loginWith({ email: 'super@test.local' })).client;
    // sanity: signed-in works, then a fresh agent without cookies is rejected
    await anonymous.get('/api/reports/due').expect(200);
    const { agent } = await import('./helpers/http');
    await agent().get('/api/reports/due').expect(401);
  });
});
