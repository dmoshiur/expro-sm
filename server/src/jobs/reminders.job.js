/**
 * Daily SMS reminders (default 09:00 Asia/Dhaka):
 *   1. installments due within REMINDER_DAYS_BEFORE days (due-soon reminder)
 *   2. overdue installments, throttled by last_reminded_at
 *
 * Anti-spam rules: never remind a settled installment, never remind the same
 * installment twice inside OVERDUE_REMINDER_INTERVAL_HOURS, cap per run.
 *
 * Link strategy: only the SHA-256 hash of a payment token is stored, so a
 * reminder cannot repeat an earlier link verbatim. Each reminder therefore
 * issues a fresh token and invalidates the previous one; the newest SMS always
 * contains the working link (documented in docs/payment-flow.md).
 */
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { addDays, dhakaDate, diffDays, isoDateOnly } from '../utils/dates.js';
import { issueToken } from '../services/paylink.service.js';
import { sendRaw } from '../services/sms.service.js';
import { renderTemplate } from '../services/sms/templates.js';

const MAX_PER_RUN = 100;

const BASE_SELECT = `
  select inst.id, inst.serial, inst.amount, inst.amount_paid, (inst.amount - inst.amount_paid) as outstanding,
         inst.due_date, inst.status, inst.last_reminded_at, inst.reminder_count,
         inst.pay_token_hash, inst.token_expires_at,
         v.investor_id, i.name as investor_name, i.mobile as investor_mobile, i.status as investor_status
    from installments inst
    join investments v on v.id = inst.investment_id
    join investors i on i.id = v.investor_id
   where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')
     and i.deleted_at is null and i.status <> 'CLOSED' and i.status <> 'INACTIVE'`;

export async function runRemindersJob({ dryRun = false } = {}) {
  const today = dhakaDate();
  const dueSoonTo = addDays(today, config.jobs.reminderDaysBefore);
  const hours = String(config.jobs.overdueReminderIntervalHours);

  const dueSoon = await query(
    `${BASE_SELECT} and inst.due_date >= $1::date and inst.due_date <= $2::date
       and (inst.last_reminded_at is null or inst.last_reminded_at < now() - ($3 || ' hours')::interval)
      order by inst.due_date asc limit $4`,
    [today, dueSoonTo, hours, MAX_PER_RUN],
  );

  const overdue = await query(
    `${BASE_SELECT} and inst.due_date < $1::date
       and (inst.last_reminded_at is null or inst.last_reminded_at < now() - ($2 || ' hours')::interval)
      order by inst.due_date asc limit $3`,
    [today, hours, MAX_PER_RUN],
  );

  const results = { dueSoonSent: 0, dueSoonFailed: 0, overdueSent: 0, overdueFailed: 0, skipped: 0 };

  for (const row of dueSoon.rows) {
    const daysLeft = Math.max(0, diffDays(today, isoDateOnly(row.due_date)));
    await sendOne(row, { kind: 'DUE', daysLeft, dryRun, results });
  }
  for (const row of overdue.rows) {
    const daysOverdue = Math.max(1, diffDays(isoDateOnly(row.due_date), today));
    await sendOne(row, { kind: 'OVERDUE', daysOverdue, dryRun, results });
  }

  return {
    itemsProcessed: results.dueSoonSent + results.overdueSent,
    detail: { asOf: today, dueSoonWindowEnds: dueSoonTo, throttleHours: Number(hours), dryRun, ...results },
  };
}

async function sendOne(row, { kind, daysLeft = 0, daysOverdue = 0, dryRun, results }) {
  const outstanding = Number(row.outstanding) > 0 ? Number(row.outstanding) : Number(row.amount);
  try {
    if (dryRun) {
      results.skipped += 1;
      return { ok: true, dryRun: true };
    }
    const issued = await issueToken(row.id, {});
    const templateKey = kind === 'OVERDUE' ? 'OVERDUE_REMINDER' : 'DUE_REMINDER';
    const message = renderTemplate(templateKey, {
      name: row.investor_name,
      serial: row.serial,
      amount: outstanding,
      dueDate: isoDateOnly(row.due_date),
      url: issued.url,
      daysLeft,
      daysOverdue,
    });
    const result = await sendRaw({
      mobile: row.investor_mobile,
      message,
      messageType: templateKey,
      templateKey,
      installmentId: row.id,
      investorId: row.investor_id,
    });
    if (result.ok) {
      await query('update installments set last_reminded_at = now(), reminder_count = reminder_count + 1 where id = $1', [row.id]);
      if (kind === 'OVERDUE') results.overdueSent += 1;
      else results.dueSoonSent += 1;
    } else if (kind === 'OVERDUE') results.overdueFailed += 1;
    else results.dueSoonFailed += 1;
    return result;
  } catch (err) {
    logger.error('reminder failed', { err, installmentId: row.id, kind });
    if (kind === 'OVERDUE') results.overdueFailed += 1;
    else results.dueSoonFailed += 1;
    return { ok: false };
  }
}
