/** Phase 6 - dashboard aggregates. */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

const firstDue = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 2));

async function setup() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  const client = (await loginWith({ email: 'super@test.local' })).client;

  const investor = await client
    .post('/api/investors')
    .send({ name: 'Nusrat Jahan', mobile: '01911111111', nid: '1999123456789' })
    .expect(201);

  const investment = await client
    .post('/api/investments')
    .send({
      investorId: investor.body.investor.id,
      totalAmount: '2000',
      installmentCount: 2,
      firstDueDate: firstDue,
      interval: { unit: 'MONTH', value: 1 },
    })
    .expect(201);

  return { client, investorId: investor.body.investor.id as string, investmentId: investment.body.investment.id as string };
}

describe('dashboard summary', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('reports invested, collected, outstanding and today collection', async () => {
    const { client } = await setup();

    const empty = await client.get('/api/dashboard').expect(200);
    expect(empty.body.totals.invested).toBe('200000');
    expect(empty.body.totals.collected).toBe('0');
    expect(empty.body.totals.outstanding).toBe('200000');
    expect(empty.body.collection.today).toBe('0');
    expect(empty.body.counts.activeInvestors).toBe(1);
    expect(empty.body.upcomingInstallments.length).toBe(2);

    // collect 500 BDT today (cash)
    const investment = await prisma.investment.findFirstOrThrow({ include: { installments: true } });
    await client
      .post(`/api/payments/installments/${investment.installments[0]!.id}/manual`)
      .send({ amount: '500', method: 'CASH', reference: 'CASH-1' })
      .expect(201);

    const after = await client.get('/api/dashboard').expect(200);
    expect(after.body.totals.collected).toBe('50000');
    expect(after.body.totals.outstanding).toBe('150000');
    expect(after.body.collection.today).toBe('50000');
    expect(after.body.collection.todayCount).toBe(1);
    expect(after.body.collection.thisMonth).toBe('50000');
    expect(after.body.recentPayments.length).toBe(1);
    expect(after.body.recentPayments[0].investorName).toBe('Nusrat Jahan');
    expect(after.body.upcomingInstallments[0].outstanding).toBe('50000'); // 1000 - 500

    // collection trend has the current month bucket
    expect(after.body.collectionByMonth.length).toBeGreaterThanOrEqual(1);
    const bucket = after.body.collectionByMonth.at(-1);
    expect(bucket.total).toBe('50000');
    expect(bucket.count).toBe(1);
  });

  it('counts overdue installments and their outstanding amount', async () => {
    const { client } = await setup();
    const investment = await prisma.investment.findFirstOrThrow({ include: { installments: true } });
    await prisma.installment.update({
      where: { id: investment.installments[0]!.id },
      data: { status: 'OVERDUE', dueDate: addDhakaDays(startOfDhakaDay(), -4) },
    });

    const response = await client.get('/api/dashboard').expect(200);
    expect(response.body.counts.overdueInstallments).toBe(1);
    expect(response.body.due.overdueAmount).toBe('100000');
    expect(response.body.due.overdueCount).toBe(1);
  });

  it('is readable by a viewer but not by anonymous callers', async () => {
    await setup();
    await createTestAdmin({ email: 'viewer@test.local', role: 'VIEWER' });
    const { client: viewer } = await loginWith({ email: 'viewer@test.local' });
    await viewer.get('/api/dashboard').expect(200);

    const { agent } = await import('./helpers/http');
    await agent().get('/api/dashboard').expect(401);
  });

  it('validates the months parameter', async () => {
    const { client } = await setup();
    await client.get('/api/dashboard?months=99').expect(400);
  });
});
