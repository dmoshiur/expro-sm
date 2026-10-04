/**
 * Installment reminders - runs daily at 09:00 Asia/Dhaka (config.cron.reminders).
 *
 * Sends two kinds of SMS:
 *   1. due soon  - PENDING/PARTIALLY_PAID installments due within
 *                  REMINDER_DAYS_BEFORE days (default 3)
 *   2. overdue   - OVERDUE installments, re-notified at most once every
 *                  REMINDER_OVERDUE_EVERY_DAYS days (default 3)
 *
 * Dedupe rules:
 *   - due reminders: at most one per calendar day (remindersSentAt defaults to
 *     the *date* part of lastRemindedAt)
 *   - overdue reminders: at most one per REMINDER_OVERDUE_EVERY_DAYS window
 *
 * A fresh payment link is generated for each reminder (link tokens are stored
 * hashed for security, so the old token cannot be recovered; the new SMS always
 * carries a working link). The superseded link stops working - documented in
 * docs/payment-flow.md.
 */
import { config } from '../config';
import { getNumberSetting, SETTING_KEYS } from '../services/settings/settings.service';
import { prisma } from '../config/prisma';
import { AuditAction, AuditEntity } from '../utils/auditActions';
import { formatBdt } from '../utils/money';
import { addDhakaDays, daysUntil, startOfDhakaDay } from '../utils/dates';
import { jobLogger } from '../utils/logger';
import { recordAudit } from '../services/audit/audit.service';
import { generateLink } from '../services/payment/link.service';
import { recordReminderSent } from '../services/installment/installment.service';
import { reminderMessage, sendSms } from '../services/sms/sms.service';
import type { JobContext, JobResult } from './scheduler';

const OVERDUE_REMINDER_EVERY_DAYS = Number(process.env.REMINDER_OVERDUE_EVERY_DAYS ?? 3);

interface ReminderCandidate {
  id: string;
  serial: number;
  amount: bigint;
  paidAmount: bigint;
  dueDate: Date;
  status: string;
  lastRemindedAt: Date | null;
  investment: {
    installmentCount: number;
    investor: { id: string; name: string; mobile: string; status: string };
  };
}

export async function sendRemindersFor(
  candidates: ReminderCandidate[],
  options: { overdue: boolean; now: Date; log: ReturnType<typeof jobLogger> },
): Promise<{ sent: number; failed: number; skipped: number }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const installment of candidates) {
    if (installment.investment.investor.status !== 'ACTIVE') {
      skipped += 1;
      continue;
    }

    try {
      const link = await generateLink(installment.id);
      const outstanding = installment.amount - installment.paidAmount;
      const body = reminderMessage({
        investorName: installment.investment.investor.name,
        installmentSerial: installment.serial,
        amount: outstanding,
        dueDate: installment.dueDate,
        url: link.url,
        overdue: options.overdue,
        daysOverdue: options.overdue ? Math.max(0, -daysUntil(installment.dueDate)) : 0,
        companyName: process.env.COMPANY_NAME,
      });

      const delivery = await sendSms({
        to: installment.investment.investor.mobile,
        body,
        purpose: options.overdue ? 'REMINDER_OVERDUE' : 'REMINDER_DUE',
        investorId: installment.investment.investor.id,
        installmentId: installment.id,
        sentByAdminId: null,
      });

      await recordReminderSent(installment.id, options.now);

      await recordAudit(
        { adminId: null },
        {
          action: AuditAction.REMINDER_SENT,
          entity: AuditEntity.INSTALLMENT,
          entityId: installment.id,
          newValue: {
            overdue: options.overdue,
            amount: outstanding.toString(),
            mobile: installment.investment.investor.mobile,
            smsSuccess: delivery.success,
            provider: delivery.provider,
          },
        },
      );

      if (delivery.success) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      options.log.warn({ err: error, installmentId: installment.id }, 'reminder could not be sent');
    }
  }

  return { sent, failed, skipped };
}

export async function reminderJob(context: JobContext): Promise<JobResult> {
  const log = context.logger ?? jobLogger('reminders');
  const now = new Date();

  if (!config.reminders.enabled) {
    log.info('reminders are disabled (REMINDER_ENABLED=false)');
    return { summary: 'reminders disabled', metrics: { sent: 0, failed: 0, skipped: 0 } };
  }

  const today = startOfDhakaDay(now);
  const daysBefore = await getNumberSetting(SETTING_KEYS.reminderDaysBefore);
  const dueWindowEnd = addDhakaDays(today, daysBefore + 1);
  const overdueCutoff = new Date(now.getTime() - OVERDUE_REMINDER_EVERY_DAYS * 24 * 60 * 60 * 1000);
  // at most one due reminder per Dhaka calendar day
  const todayCutoff = addDhakaDays(today, -1);

  const select = {
    id: true,
    serial: true,
    amount: true,
    paidAmount: true,
    dueDate: true,
    status: true,
    lastRemindedAt: true,
    investment: {
      select: {
        installmentCount: true,
        investor: { select: { id: true, name: true, mobile: true, status: true } },
      },
    },
  } as const;

  const [dueSoon, overdue] = await Promise.all([
    prisma.installment.findMany({
      where: {
        status: { in: ['PENDING', 'PARTIALLY_PAID'] },
        dueDate: { gte: today, lt: dueWindowEnd },
        investment: { status: 'ACTIVE' },
        OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: todayCutoff } }],
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
      select,
    }),
    prisma.installment.findMany({
      where: {
        status: 'OVERDUE',
        investment: { status: 'ACTIVE' },
        OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: overdueCutoff } }],
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
      select,
    }),
  ]);

  const dueResult = await sendRemindersFor(dueSoon, { overdue: false, now, log });
  const overdueResult = await sendRemindersFor(overdue, { overdue: true, now, log });

  const metrics = {
    dueCandidates: dueSoon.length,
    overdueCandidates: overdue.length,
    sent: dueResult.sent + overdueResult.sent,
    failed: dueResult.failed + overdueResult.failed,
    skipped: dueResult.skipped + overdueResult.skipped,
  };

  log.info(metrics, 'reminder run finished');
  return {
    summary:
      `due: ${dueSoon.length} candidate(s), overdue: ${overdue.length} candidate(s), ` +
      `sent ${metrics.sent}, failed ${metrics.failed}`,
    metrics,
  };
}

export const reminderJobInternals = { sendRemindersFor };
export default reminderJob;
export function totalOutstanding(installment: Pick<ReminderCandidate, 'amount' | 'paidAmount'>): string {
  return formatBdt(installment.amount - installment.paidAmount);
}
