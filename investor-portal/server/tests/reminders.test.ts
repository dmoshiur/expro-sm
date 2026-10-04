/** Phase 6 - due and overdue SMS reminders (cron job). */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { consoleOutbox } from '../src/services/sms/providers/console.provider';
import { reminderJob } from '../src/jobs/reminder.job';
import type { JobContext } from '../src/jobs/scheduler';
import { jobLogger } from '../src/utils/logger';
import { sha256 } from '../src/utils/encryption';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

const context = (): JobContext => ({ startedAt: new Date(), logger: jobLogger('reminders') });
const firstDue = formatDhakaDate(addDhakaDays(startOfDhakaDay(), 2));

async function setup() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  const client = (await loginWith({ email: 'super@test.local' })).client;

  const investor = await client
    .post('/api/investors')
    .send({ name: 'Tanvir Hasan', mobile: '01712345678', nid: '1995113456789' })
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

  const installments = investment.body.investment.installments as Array<{ id: string }>;
  return { client, investorId: investor.body.investor.id as string, installments };
}

describe('reminder job', () => {
  beforeEach(async () => {
    await truncateAll();
    consoleOutbox.clear();
  });

  it('sends a due-soon reminder with a fresh payment link and records it', async () => {
    const { installments } = await setup();
    // installment 1 due tomorrow (inside the 3-day window)
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { dueDate: addDhakaDays(startOfDhakaDay(), 1) },
    });

    const result = await reminderJob(context());
    expect(result?.metrics?.sent).toBe(1);

    const sms = consoleOutbox.last();
    expect(sms).toBeDefined();
    expect(sms!.to).toContain('01712345678');
    expect(sms!.body).toContain('reminder');
    expect(sms!.body).toMatch(/\/pay\/[A-Za-z0-9_-]+/);

    const row = await prisma.installment.findUniqueOrThrow({ where: { id: installments[0]!.id } });
    expect(row.lastRemindedAt).not.toBeNull();
    expect(row.payTokenHash).not.toBeNull();

    // the SMS body contains the raw token; only its hash may be stored
    const rawToken = /\/pay\/([A-Za-z0-9_-]+)/.exec(sms!.body)![1]!;
    expect(row.payTokenHash).toBe(sha256(rawToken));
    expect(row.payTokenHash).not.toContain(rawToken);

    expect((await auditRows(AuditAction.REMINDER_SENT)).length).toBe(1);
  });

  it('does not remind twice for the same due installment on the same day', async () => {
    const { installments } = await setup();
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { dueDate: addDhakaDays(startOfDhakaDay(), 1) },
    });

    await reminderJob(context());
    await reminderJob(context());
    expect(consoleOutbox.all().length).toBe(1);

    // ...but does remind again the next day
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { lastRemindedAt: addDhakaDays(new Date(), -2) },
    });
    await reminderJob(context());
    expect(consoleOutbox.all().length).toBe(2);
  });

  it('reminds overdue installments but respects the re-notify window', async () => {
    const { installments } = await setup();
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { status: 'OVERDUE', dueDate: addDhakaDays(startOfDhakaDay(), -7) },
    });

    await reminderJob(context());
    const first = consoleOutbox.last();
    expect(first!.body).toMatch(/overdue/);
    expect(first!.body).toContain('7 days overdue');

    // running again the same day must not nag
    await reminderJob(context());
    expect(consoleOutbox.all().length).toBe(1);

    // after the 3-day window it reminds again
    await prisma.installment.update({
      where: { id: installments[0]!.id },
      data: { lastRemindedAt: addDhakaDays(new Date(), -4) },
    });
    await reminderJob(context());
    expect(consoleOutbox.all().length).toBe(2);
  });

  it('skips paid, waived and cancelled installments and inactive investors', async () => {
    const { installments, investorId, client } = await setup();
    const dueSoon = addDhakaDays(startOfDhakaDay(), 1);
    await prisma.installment.update({ where: { id: installments[0]!.id }, data: { dueDate: dueSoon } });
    await prisma.installment.update({
      where: { id: installments[1]!.id },
      data: { dueDate: dueSoon, status: 'WAIVED' },
    });

    // first run: exactly one reminder
    await reminderJob(context());
    expect(consoleOutbox.all().length).toBe(1);

    // deactivate the investor: nothing more is sent
    consoleOutbox.clear();
    await client.post(`/api/investors/${investorId}/deactivate`).expect(200);
    await prisma.installment.update({ where: { id: installments[0]!.id }, data: { lastRemindedAt: null } });
    const result = await reminderJob(context());
    expect(consoleOutbox.all().length).toBe(0);
    expect(result?.metrics?.skipped).toBe(1);
  });

  it('does nothing when there is nothing due', async () => {
    const { installments } = await setup();
    // push both installments outside the reminder window
    await prisma.installment.updateMany({
      where: { id: { in: installments.map((row) => row.id) } },
      data: { dueDate: addDhakaDays(startOfDhakaDay(), 30) },
    });
    const result = await reminderJob(context());
    expect(result?.metrics?.sent).toBe(0);
    expect(consoleOutbox.all().length).toBe(0);
  });
});
