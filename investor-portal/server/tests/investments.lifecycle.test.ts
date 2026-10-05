import { beforeEach, describe, expect, it } from 'vitest';
import { findInvariantViolations } from '../scripts/lib/invariants.mjs';
import { AuditAction } from '../src/utils/auditActions';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith, request, app } from './helpers/http';

async function superAdminClient() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  return (await loginWith({ email: 'super@test.local' })).client;
}

async function seedInvestor(client: Awaited<ReturnType<typeof loginWith>>['client'], mobile = '01712345678') {
  const response = await client
    .post('/api/investors')
    .send({ name: 'Investment Investor', mobile })
    .expect(201);
  return response.body.investor.id as string;
}

const firstDue = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 7));

describe('investments: creation, split, editing', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('creates an investment and splits the total, remainder on the LAST installment', async () => {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);

    const response = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '10,000.00', installmentCount: 3, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);

    const investment = response.body.investment;
    expect(investment.totalAmount).toBe('1000000');
    expect(investment.installments).toHaveLength(3);
    expect(investment.installments.map((i: { amount: string }) => i.amount)).toEqual(['333333', '333333', '333334']);
    expect(investment.scheduledTotal).toBe('1000000');
    expect(investment.outstanding).toBe('1000000');
    expect(investment.progress).toBe(0);

    const rows = await prisma.installment.findMany({ where: { investmentId: investment.id }, orderBy: { serial: 'asc' } });
    expect(rows.map((row) => row.serial)).toEqual([1, 2, 3]);
    expect(rows[2]!.amount - rows[0]!.amount).toBe(1n);
    expect(formatDhakaDate(rows[0]!.dueDate)).toBe(firstDue);

    const audits = await auditRows(AuditAction.INVESTMENT_CREATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toMatchObject({ installmentCount: 3, totalAmount: '1000000' });
  });

  it('keeps installments aligned with the investment total (service guard + integrity checker)', async () => {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);
    const created = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '5000', installmentCount: 2, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);

    const [first] = await prisma.installment.findMany({
      where: { investmentId: created.body.investment.id },
      orderBy: { serial: 'asc' },
    });

    // The API refuses to re-price a schedule that no longer adds up (422), so a
    // service-mediated write can never break the invariant...
    await client
      .put(`/api/investments/${created.body.investment.id}/installments`)
      .send({ installments: [{ id: first!.id, amount: '1000' }] })
      .expect(422);

    const unchanged = await prisma.installment.findUnique({ where: { id: first!.id } });
    expect(unchanged!.amount).toBe(first!.amount);

    // ...and SQLite has no deferred constraint triggers, so `npm run db:check`
    // is the backstop for raw SQL that bypasses the service entirely.
    const violations = await findInvariantViolations((sql) => prisma.$queryRawUnsafe(sql));
    expect(violations).toEqual([]);
  });

  it('rejects an edit whose amounts no longer add up', async () => {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);
    const created = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '3000', installmentCount: 3, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);
    const installments = created.body.investment.installments;

    const response = await client
      .put(`/api/investments/${created.body.investment.id}/installments`)
      .send({ installments: [{ id: installments[0].id, amount: '2000' }] })
      .expect(422);
    expect(response.body.error.message).toMatch(/add up to the investment total/i);
  });

  it('accepts a balanced edit of amounts and due dates', async () => {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);
    const created = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '3000', installmentCount: 3, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);
    const installments = created.body.investment.installments as Array<{ id: string }>;
    const newDate = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 45));

    const updated = await client
      .put(`/api/investments/${created.body.investment.id}/installments`)
      .send({
        installments: [
          { id: installments[0]!.id, amount: '500.00' },
          { id: installments[1]!.id, amount: '1000.00' },
          { id: installments[2]!.id, amount: '1500.00', dueDate: newDate },
        ],
      })
      .expect(200);

    expect(updated.body.investment.installments.map((i: { amount: string }) => i.amount)).toEqual(['50000', '100000', '150000']);
    expect(formatDhakaDate(updated.body.investment.installments[2].dueDate)).toBe(newDate);
    // only the installments whose values actually changed are audited
    const edits = await auditRows(AuditAction.INSTALLMENT_UPDATED);
    expect(edits).toHaveLength(2);
    expect(edits.map((row) => row.newValue)).toEqual(
      expect.arrayContaining([expect.objectContaining({ amount: '50000' }), expect.objectContaining({ amount: '150000' })]),
    );
  });

  it('rejects an edit that does not belong to the investment', async () => {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);
    const a = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '1000', installmentCount: 1, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);
    const b = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '1000', installmentCount: 1, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);

    await client
      .put(`/api/investments/${a.body.investment.id}/installments`)
      .send({ installments: [{ id: b.body.investment.installments[0].id, amount: '1000' }] })
      .expect(400);
  });

  it('refuses investments for inactive investors or invalid input', async () => {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);
    await client.post(`/api/investors/${investorId}/deactivate`).expect(200);

    const inactive = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '1000', installmentCount: 2, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(422);
    expect(inactive.body.error.message).toMatch(/inactive/i);

    await client.post(`/api/investors/${investorId}/reactivate`).expect(200);
    await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '1000', installmentCount: 0, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(400);
    await client
      .post('/api/investments')
      .send({ investorId: '00000000-0000-0000-0000-000000000000', totalAmount: '1000', installmentCount: 1, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(404);
  });
});

describe('installments: waive, cancel, reopen, overdue', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function setup() {
    const client = await superAdminClient();
    const investorId = await seedInvestor(client);
    const created = await client
      .post('/api/investments')
      .send({ investorId, totalAmount: '3000', installmentCount: 3, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(201);
    return { client, investmentId: created.body.investment.id as string, installments: created.body.investment.installments as Array<{ id: string }> };
  }

  it('waives an installment with a reason and audits it', async () => {
    const { client, investmentId, installments } = await setup();

    const response = await client
      .post(`/api/installments/${installments[1]!.id}/waive`)
      .send({ reason: 'Goodwill waiver approved by management' })
      .expect(200);

    expect(response.body.investment.installments[1].status).toBe('WAIVED');
    expect(response.body.investment.installments[1].waivedReason).toMatch(/Goodwill/);
    expect(response.body.investment.payableTotal).toBe('200000'); // 3000 - 1000 waived
    expect(response.body.investment.outstanding).toBe('200000');

    const audits = await auditRows(AuditAction.INSTALLMENT_WAIVED);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toMatchObject({ status: 'WAIVED', reason: 'Goodwill waiver approved by management' });

    // a reason is mandatory
    await client.post(`/api/installments/${installments[0]!.id}/waive`).send({ reason: '' }).expect(400);
    void investmentId;
  });

  it('cancels an installment and can reopen it', async () => {
    const { client, installments } = await setup();

    const cancelled = await client
      .post(`/api/installments/${installments[2]!.id}/cancel`)
      .send({ reason: 'Duplicate schedule entry' })
      .expect(200);
    expect(cancelled.body.investment.installments[2].status).toBe('CANCELLED');

    const reopened = await client
      .post(`/api/installments/${installments[2]!.id}/reopen`)
      .send({ reason: 'Reinstated after review' })
      .expect(200);
    expect(reopened.body.investment.installments[2].status).toBe('PENDING');
    expect(await auditRows(AuditAction.INSTALLMENT_UNWAIVED)).toHaveLength(1);
  });

  it('marks the investment COMPLETED when nothing is left to collect', async () => {
    const { client, investmentId, installments } = await setup();
    for (const installment of installments) {
      await client.post(`/api/installments/${installment.id}/waive`).send({ reason: 'Settled outside the portal' }).expect(200);
    }
    const investment = await prisma.investment.findUnique({ where: { id: investmentId } });
    expect(investment!.status).toBe('COMPLETED');
  });

  it('cancels a whole investment and only touches unpaid installments', async () => {
    const { client, investmentId, installments } = await setup();

    // pretend the first installment was paid
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { status: 'PAID', paidAmount: 100000n, paidAt: new Date() },
    });

    const response = await client
      .post(`/api/investments/${investmentId}/cancel`)
      .send({ reason: 'Investor withdrew from the scheme' })
      .expect(200);

    expect(response.body.investment.status).toBe('CANCELLED');
    const rows = await prisma.installment.findMany({ where: { investmentId }, orderBy: { serial: 'asc' } });
    expect(rows.map((row) => row.status)).toEqual(['PAID', 'CANCELLED', 'CANCELLED']);
    expect(await auditRows(AuditAction.INVESTMENT_CANCELLED)).toHaveLength(1);

    // idempotency guard
    await client.post(`/api/investments/${investmentId}/cancel`).send({ reason: 'again' }).expect(409);
  });

  it('blocks waiving an installment that already received money', async () => {
    const { client, installments } = await setup();
    const installment = await prisma.installment.findUnique({ where: { id: installments[0]!.id } });
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          installmentId: installments[0]!.id,
          gateway: 'MANUAL',
          method: 'CASH',
          amount: installment!.amount,
          status: 'SUCCESS',
          manualReference: 'CASH-001',
          completedAt: new Date(),
        },
      });
    });

    const response = await client
      .post(`/api/installments/${installments[0]!.id}/waive`)
      .send({ reason: 'not allowed' })
      .expect(409);
    expect(response.body.error.message).toMatch(/received money|paid/i);
  });

  it('lists installments for the due/overdue report with investor context', async () => {
    const { client } = await setup();
    const list = await client.get('/api/installments?statuses=PENDING,OVERDUE&pageSize=50').expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0].investor.name).toBe('Investment Investor');
    expect(list.body.items[0].dueDateLabel).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const filtered = await client.get(`/api/installments?from=${firstDue}&to=${firstDue}`).expect(200);
    expect(filtered.body.items.length).toBeGreaterThan(0);
  });

  it('is read-only for VIEWER role', async () => {
    const { investmentId, installments } = await setup();
    await createTestAdmin({ email: 'viewer@test.local', role: 'VIEWER' });
    const viewer = (await loginWith({ email: 'viewer@test.local' })).client;

    await viewer.get(`/api/investments/${investmentId}`).expect(200);
    await viewer.post(`/api/installments/${installments[0]!.id}/waive`).send({ reason: 'nope' }).expect(403);
    await viewer
      .post('/api/investments')
      .send({ investorId: '00000000-0000-0000-0000-000000000000', totalAmount: '1', installmentCount: 1, firstDueDate: firstDue, interval: { unit: 'MONTH', value: 1 } })
      .expect(403);
  });

  it('requires authentication for every investment route', async () => {
    await request(app).get('/api/investments').expect(401);
    await request(app).get('/api/installments').expect(401);
    await request(app).post('/api/investments').send({}).expect(401);
  });
});
