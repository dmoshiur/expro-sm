/** Phase 7 - runtime settings (super admin), incl. their effect on links/reminders. */
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../src/utils/auditActions';
import { addDhakaDays, formatDhakaDate, startOfDhakaDay } from '../src/utils/dates';
import { consoleOutbox } from '../src/services/sms/providers/console.provider';
import { reminderJob } from '../src/jobs/reminder.job';
import type { JobContext } from '../src/jobs/scheduler';
import { jobLogger } from '../src/utils/logger';
import { auditRows, createTestAdmin, prisma, truncateAll } from './helpers/db';
import { loginWith } from './helpers/http';

const context = (): JobContext => ({ startedAt: new Date(), logger: jobLogger('reminders') });

async function setup() {
  await createTestAdmin({ email: 'super@test.local', role: 'SUPER_ADMIN' });
  await createTestAdmin({ email: 'accountant@test.local', role: 'ACCOUNTANT' });

  const { client } = await loginWith({ email: 'super@test.local' });
  const investor = await client
    .post('/api/investors')
    .send({ name: 'Setting Test', mobile: '01555111222', nid: '1994123456780' })
    .expect(201);
  const investment = await client
    .post('/api/investments')
    .send({
      investorId: investor.body.investor.id,
      totalAmount: '1000',
      installmentCount: 1,
      firstDueDate: formatDhakaDate(addDhakaDays(startOfDhakaDay(), 10)),
      interval: { unit: 'MONTH', value: 1 },
    })
    .expect(201);
  return { client, installmentId: investment.body.investment.installments[0].id as string };
}

describe('settings', () => {
  beforeEach(async () => {
    await truncateAll();
    consoleOutbox.clear();
  });

  it('lists settings with defaults and lets a super admin override them', async () => {
    const { client } = await setup();

    const before = await client.get('/api/settings').expect(200);
    const ttl = before.body.settings.find((setting: { key: string }) => setting.key === 'payment_link_ttl_days');
    expect(ttl.isOverridden).toBe(false);
    expect(Number(ttl.value)).toBeGreaterThan(0);

    const after = await client.put('/api/settings').send({ payment_link_ttl_days: 30, company_name: 'Acme Investments' }).expect(200);
    expect(after.body.settings.find((setting: { key: string }) => setting.key === 'payment_link_ttl_days').value).toBe('30');
    expect(after.body.settings.find((setting: { key: string }) => setting.key === 'company_name').isOverridden).toBe(true);

    const rows = await auditRows(AuditAction.SETTING_UPDATED);
    expect(rows.length).toBe(2);
    expect(await prisma.setting.count()).toBe(2);
  });

  it('rejects unknown keys, bad types and blocked roles', async () => {
    const { client } = await setup();
    await client.put('/api/settings').send({ not_a_setting: 'x' }).expect(400);
    await client.put('/api/settings').send({ payment_link_ttl_days: 'forever' }).expect(400);
    await client.put('/api/settings').send({ payment_link_ttl_days: 999 }).expect(400);
    await client.put('/api/settings').send({}).expect(400);

    const { client: accountant } = await loginWith({ email: 'accountant@test.local' });
    await accountant.get('/api/settings').expect(403);
    await accountant.put('/api/settings').send({ company_name: 'Nope' }).expect(403);
  });

  it('applies the configured link validity when generating a payment link', async () => {
    const { client, installmentId } = await setup();
    await client.put('/api/settings').send({ payment_link_ttl_days: 21 }).expect(200);

    await client.post(`/api/payments/installments/${installmentId}/link/regenerate`).send({ sendSms: false }).expect(200);

    const installment = await prisma.installment.findUniqueOrThrow({ where: { id: installmentId } });
    const days = Math.round((installment.tokenExpiresAt!.getTime() - Date.now()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(20);
    expect(days).toBeLessThanOrEqual(22);
  });

  it('applies the reminder lead time to the reminder job', async () => {
    const { client, installmentId } = await setup();
    // due in 10 days: outside the default 3-day window
    await client.put('/api/settings').send({ reminder_days_before: 12 }).expect(200);

    const result = await reminderJob(context());
    expect(result?.metrics?.sent).toBe(1);

    // with the default window the same installment is not due yet
    await prisma.setting.update({ where: { key: 'reminder_days_before' }, data: { value: '3' } });
    await prisma.installment.update({ where: { id: installmentId }, data: { lastRemindedAt: null } });
    consoleOutbox.clear();
    const second = await reminderJob(context());
    expect(second?.metrics?.sent).toBe(0);
  });
});
