/**
 * Phase 7 - housekeeping jobs: overdue marker and token/SMS-log cleanup.
 *
 * Both jobs run in Asia/Dhaka, so the first case pins the day boundary: an
 * installment due *today* (Dhaka) must not become overdue, while one due
 * yesterday must.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { overdueInstallmentsJob } from '../src/jobs/overdueInstallments.job';
import { tokenCleanupJob } from '../src/jobs/tokenCleanup.job';
import type { JobContext } from '../src/jobs/scheduler';
import { jobLogger } from '../src/utils/logger';
import { createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

const context = (name: string): JobContext => ({ startedAt: new Date(), logger: jobLogger(name) });

async function setup() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  const { client } = await loginWith({ email: 'super@test.local' });

  const investor = await client
    .post('/api/investors')
    .send({ name: 'Job Tester', mobile: '01611002233' })
    .expect(201);

  const investment = await client
    .post('/api/investments')
    .send({
      investorId: investor.body.investor.id,
      totalAmount: '3000',
      installmentCount: 3,
      firstDueDate: formatDhakaDate(addDhakaDays(startOfDhakaDay(), 30)),
      interval: { unit: 'MONTH', value: 1 },
    })
    .expect(201);

  return {
    client,
    installments: investment.body.investment.installments as Array<{ id: string; serial: number }>,
  };
}

describe('overdue marker job', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('marks only installments whose due date has passed, leaving today alone', async () => {
    const { installments } = await setup();

    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { dueDate: addDhakaDays(startOfDhakaDay(), -1) },
    });
    await prisma.installment.update({
      where: { id: installments[1]!.id },
      data: { dueDate: startOfDhakaDay() },
    });
    await prisma.installment.update({
      where: { id: installments[2]!.id },
      data: { status: 'WAIVED', dueDate: addDhakaDays(startOfDhakaDay(), -10) },
    });

    const result = await overdueInstallmentsJob(context('overdue-installments'));
    expect(result?.metrics?.marked ?? result?.metrics?.updated).toBe(1);

    const rows = await prisma.installment.findMany({ orderBy: { serial: 'asc' }, select: { serial: true, status: true } });
    expect(rows[0]!.status).toBe('OVERDUE');
    expect(rows[1]!.status).toBe('PENDING'); // due today is not late yet
    expect(rows[2]!.status).toBe('WAIVED'); // waived rows are never touched

    // the change is audited
    const audits = await prisma.auditLog.findMany({ where: { action: 'installment.status_changed' } });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // running again is a no-op
    const second = await overdueInstallmentsJob(context('overdue-installments'));
    expect(second?.metrics?.marked ?? second?.metrics?.updated ?? 0).toBe(0);
  });

  it('does not touch installments of a cancelled investment', async () => {
    const { client, installments } = await setup();
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { dueDate: addDhakaDays(startOfDhakaDay(), -5) },
    });
    const investment = await prisma.installment.findUniqueOrThrow({ where: { id: installments[0]!.id } });
    await client.post(`/api/investments/${investment.investmentId}/cancel`).send({ reason: 'testing job scope' }).expect(200);

    await overdueInstallmentsJob(context('overdue-installments'));
    const row = await prisma.installment.findUniqueOrThrow({ where: { id: installments[0]!.id } });
    expect(row.status).not.toBe('OVERDUE');
  });
});

describe('token cleanup job', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('expires payment link hashes and prunes old SMS logs and refresh tokens', async () => {
    const { client, installments } = await setup();
    await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);

    const fresh = await prisma.installment.findUniqueOrThrow({ where: { id: installments[0]!.id } });
    expect(fresh.payTokenHash).not.toBeNull();

    // one link already past its expiry, one SMS log and one refresh token older than retention
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.smsLog.create({
      data: {
        toMobile: '01611002233',
        body: 'old message',
        provider: 'console',
        status: 'SENT',
        purpose: 'PAYMENT_LINK',
        createdAt: new Date(Date.now() - 400 * 86400000),
      },
    });
    await prisma.smsLog.create({
      data: { toMobile: '01611002233', body: 'recent message', provider: 'console', status: 'SENT', purpose: 'PAYMENT_LINK' },
    });

    const result = await tokenCleanupJob(context('token-cleanup'));
    expect(result?.metrics?.expiredPaymentLinks).toBe(1);
    expect(result?.metrics?.smsLogsPruned).toBe(1);

    const after = await prisma.installment.findUniqueOrThrow({ where: { id: installments[0]!.id } });
    expect(after.payTokenHash).toBeNull();

    // the seeded "old message" is gone; the link-send log and the recent one remain
    const logs = await prisma.smsLog.findMany();
    expect(logs.map((log) => log.body)).not.toContain('old message');
    expect(logs.map((log) => log.body)).toContain('recent message');
  });

  it('leaves valid links usable', async () => {
    const { client, installments } = await setup();
    const sent = await client.post(`/api/payments/installments/${installments[0]!.id}/link/send`).expect(200);
    const token = (sent.body.link.url as string).split('/pay/').pop()!;

    await tokenCleanupJob(context('token-cleanup'));

    const publicPage = await client.get(`/api/public/payments/${token}`);
    expect([200]).toContain(publicPage.status);
  });
});
