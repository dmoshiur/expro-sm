import { beforeEach, describe, expect, it } from 'vitest';
import { findInvariantViolations } from '../scripts/lib/invariants.mjs';
import { createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

/**
 * SQLite/Turso has no deferred constraint triggers, so the two invariants that
 * PostgreSQL checked at COMMIT time are enforced by the services and verified by
 * `npm run db:check` (scripts/check-invariants.mjs). These tests make sure the
 * checker really detects drift - a checker that never fails is worse than none.
 */
const execute = (sql: string) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);

async function superAdminClient() {
  await createTestAdmin({ email: 'checker@test.local', role: 'SUPER_ADMIN' });
  const { client } = await loginWith({ email: 'checker@test.local' });
  return client;
}

describe('database invariants', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('reports a consistent database after normal API writes', async () => {
    const client = await superAdminClient();
    const investor = await client.post('/api/investors').send({ name: 'Integrity Investor', mobile: '01711000999' }).expect(201);
    await client
      .post('/api/investments')
      .send({
        investorId: investor.body.investor.id,
        totalAmount: '3000',
        installmentCount: 3,
        firstDueDate: '2026-12-01',
        interval: { unit: 'MONTH', value: 1 },
      })
      .expect(201);

    expect(await findInvariantViolations(execute)).toEqual([]);
    const health = await client.get('/api/health').expect(200);
    expect(health.body).toMatchObject({ database: 'up', schema: 'ready' });
  });

  it('detects installments that drift from the investment total', async () => {
    const investor = await prisma.investor.create({ data: { name: 'Drift Investor', mobile: '01711000888' } });
    const investment = await prisma.investment.create({
      data: { investorId: investor.id, totalAmount: 1000n, installmentCount: 2, status: 'ACTIVE' },
    });
    await prisma.installment.createMany({
      data: [
        { investmentId: investment.id, serial: 1, amount: 500n, dueDate: new Date('2026-12-01T00:00:00Z'), status: 'PENDING' },
        { investmentId: investment.id, serial: 2, amount: 500n, dueDate: new Date('2027-01-01T00:00:00Z'), status: 'PENDING' },
      ],
    });
    expect(await findInvariantViolations(execute)).toEqual([]);

    // A raw write that bypasses the service: PostgreSQL's deferred trigger
    // refused it at COMMIT; SQLite lets it through, so the checker must see it.
    await prisma.installment.update({
      where: { investmentId_serial: { investmentId: investment.id, serial: 1 } },
      data: { amount: 400n },
    });

    const violations = await findInvariantViolations(execute);
    expect(
      violations.some(
        (violation) => violation.rule.includes('installments.sum(amount)') && violation.entityId === investment.id,
      ),
    ).toBe(true);

    // restoring the amount puts the database back in a consistent state
    await prisma.installment.update({
      where: { investmentId_serial: { investmentId: investment.id, serial: 1 } },
      data: { amount: 500n },
    });
    expect(await findInvariantViolations(execute)).toEqual([]);
  });

  it('detects nominee shares that do not add up to 100', async () => {
    const investor = await prisma.investor.create({ data: { name: 'Nominee Investor', mobile: '01711000777' } });
    await prisma.nominee.create({
      data: { investorId: investor.id, name: 'Nominee One', relation: 'Spouse', mobile: '01711000666', sharePercent: 60 },
    });

    const violations = await findInvariantViolations(execute);
    expect(
      violations.some(
        (violation) => violation.rule.includes('nominees.sum(sharePercent)') && violation.entityId === investor.id,
      ),
    ).toBe(true);
  });

  it('keeps the service validators in front of the database (unbalanced edit is a 422)', async () => {
    const client = await superAdminClient();
    const investor = await client.post('/api/investors').send({ name: 'Edit Investor', mobile: '01711000555' }).expect(201);
    const created = await client
      .post('/api/investments')
      .send({
        investorId: investor.body.investor.id,
        totalAmount: '3000',
        installmentCount: 3,
        firstDueDate: '2026-12-01',
        interval: { unit: 'MONTH', value: 1 },
      })
      .expect(201);

    await client
      .put(`/api/investments/${created.body.investment.id}/installments`)
      .send({ installments: [{ id: created.body.investment.installments[0].id, amount: '2000' }] })
      .expect(422);

    expect(await findInvariantViolations(execute)).toEqual([]);
  });
});
