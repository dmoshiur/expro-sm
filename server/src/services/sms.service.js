/**
 * SMS service: template rendering, provider dispatch, logging and audit.
 *
 * Every message is written to sms_logs with a MASKED mobile number and a short
 * body preview - never the full number, never a payment token.
 */
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { maskMobile } from '../utils/mask.js';
import { badRequest } from '../utils/errors.js';
import { createSmsProvider } from './sms/providers.js';
import { renderTemplate } from './sms/templates.js';
import * as audit from './audit.service.js';
import { buildPayUrl, issueToken, buildCallbackUrl } from './paylink.service.js';
import { isoDateOnly } from '../utils/dates.js';

let provider = createSmsProvider();
const outboxCache = [];

/** Adapter injection point (tests swap in the memory provider). */
export function setSmsProvider(next) {
  provider = next;
  logger.info('sms provider set', { provider: provider?.name });
}

export function getSmsProvider() {
  return provider;
}

export function recentSmsDebug(limit = 20) {
  return outboxCache.slice(-limit);
}

function logToDb(entry) {
  return query(
    `insert into sms_logs (installment_id, investor_id, mobile_masked, message_type, provider,
                           provider_message_id, provider_status, template_key, body_preview, error, sent_by_admin_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [
      entry.installmentId ?? null,
      entry.investorId ?? null,
      maskMobile(entry.mobile),
      entry.messageType,
      entry.provider ?? provider.name,
      entry.providerMessageId ?? null,
      entry.status ?? 'QUEUED',
      entry.templateKey ?? null,
      entry.body.slice(0, 160),
      entry.error ? String(entry.error).slice(0, 300) : null,
      entry.adminId ?? null,
    ],
  );
}

/**
 * Send one SMS through the configured provider and log it.
 * Never throws for provider failures - returns { ok:false, error } so bulk jobs
 * can continue and report a summary.
 */
export async function sendRaw({ mobile, message, messageType, templateKey = null, installmentId = null, investorId = null, adminId = null, req = null, dryRun = null }) {
  const isDryRun = dryRun === null ? config.sms.dryRun : dryRun;
  if (!mobile) throw badRequest('Recipient mobile number is required');
  const entry = {
    mobile,
    body: message,
    messageType,
    templateKey,
    installmentId,
    investorId,
    adminId,
    provider: provider.name,
    status: 'QUEUED',
  };
  outboxCache.push({ ...entry, mobile: maskMobile(mobile), at: new Date().toISOString() });
  if (outboxCache.length > 100) outboxCache.shift();

  if (isDryRun && provider.name === 'console') {
    // console provider is already a dry run
  }

  let result = { ok: true, status: 'SENT', providerMessageId: null, raw: { skipped: true } };
  try {
    result = await provider.send({ to: mobile, message, senderId: config.sms.senderId, messageType, installmentId, investorId });
  } catch (err) {
    logger.error('sms provider threw', { err, provider: provider.name });
    result = { ok: false, status: 'FAILED', error: err?.message ?? 'provider error' };
  }

  try {
    const res = await logToDb({
      ...entry,
      status: result.ok ? result.status ?? 'SENT' : 'FAILED',
      providerMessageId: result.providerMessageId,
      error: result.error,
    });
    if (result.raw && !result.ok) {
      logger.warn('sms failed', { smsLogId: res.rows[0].id, provider: provider.name, status: result.status });
    }
    await audit.record({
      action: result.ok ? audit.AUDIT_ACTIONS.SMS_SENT : audit.AUDIT_ACTIONS.SMS_FAILED,
      entity: 'sms',
      entityId: res.rows[0].id,
      newValue: { type: messageType, masked_to: maskMobile(mobile), provider: provider.name, status: result.status },
      actor: adminId ? { id: adminId } : null,
      req,
    });
  } catch (err) {
    logger.error('sms log failed', { err });
  }

  return { ok: Boolean(result.ok), status: result.status ?? (result.ok ? 'SENT' : 'FAILED'), error: result.error ?? null };
}

/** Builds and sends the "here is your payment link" SMS (issuing a token first). */
export async function sendPaymentLink({ installment, token, url, adminId = null, req = null, actor = null }) {
  const link = url ?? buildPayUrl(token);
  const message = renderTemplate('PAYMENT_LINK', {
    name: installment.investor_name,
    serial: installment.serial,
    amount: installment.amount,
    dueDate: isoDateOnly(installment.due_date),
    url: link,
  });
  return sendRaw({
    mobile: installment.investor_mobile,
    message,
    messageType: 'PAYMENT_LINK',
    templateKey: 'PAYMENT_LINK',
    installmentId: installment.id,
    investorId: installment.investor_id,
    adminId: actor?.id ?? adminId,
    req,
  });
}

export async function sendReminderForInstallment({ installment, kind, daysLeft = 0, daysOverdue = 0, url = null, req = null }) {
  const token = await issueToken(installment.id, { regenerate: false, actor: null, req: null });
  const link = url ?? token.url;
  const templateKey = kind === 'OVERDUE' ? 'OVERDUE_REMINDER' : 'DUE_REMINDER';
  const message = renderTemplate(templateKey, {
    name: installment.investor_name,
    serial: installment.serial,
    amount: installment.amount,
    dueDate: isoDateOnly(installment.due_date),
    url: link,
    daysLeft,
    daysOverdue,
  });
  const result = await sendRaw({
    mobile: installment.investor_mobile,
    message,
    messageType: templateKey,
    templateKey,
    installmentId: installment.id,
    investorId: installment.investor_id,
    req,
  });
  if (result.ok) {
    await query('update installments set last_reminded_at = now(), reminder_count = reminder_count + 1 where id = $1', [
      installment.id,
    ]);
  }
  return { ...result, url: link };
}

export async function sendPaymentSuccessSms({ payment, installment, req = null }) {
  const message = renderTemplate('PAYMENT_SUCCESS', {
    name: installment.investor_name,
    serial: installment.serial,
    amount: payment.amount,
    trxId: payment.trx_id ?? payment.manual_reference ?? 'N/A',
  });
  return sendRaw({
    mobile: installment.investor_mobile,
    message,
    messageType: 'PAYMENT_SUCCESS',
    templateKey: 'PAYMENT_SUCCESS',
    installmentId: installment.id,
    investorId: installment.investor_id,
    req,
  });
}

export async function sendManualPaymentSms({ payment, installment, req = null, actor = null }) {
  const message = renderTemplate('MANUAL', {
    name: installment.investor_name,
    serial: installment.serial,
    amount: payment.amount,
    reference: payment.manual_reference,
    method: payment.method,
  });
  return sendRaw({
    mobile: installment.investor_mobile,
    message,
    messageType: 'MANUAL',
    templateKey: 'MANUAL',
    installmentId: installment.id,
    investorId: installment.investor_id,
    adminId: actor?.id ?? null,
    req,
  });
}

export async function listSmsLogs(filters = {}, client = undefined) {
  const where = [];
  const params = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filters.installmentId) where.push(`s.installment_id = ${push(filters.installmentId)}`);
  if (filters.investorId) where.push(`s.investor_id = ${push(filters.investorId)}`);
  if (filters.messageType) where.push(`s.message_type = ${push(filters.messageType)}`);
  if (filters.providerStatus) where.push(`s.provider_status = ${push(filters.providerStatus)}`);
  if (filters.from) where.push(`s.created_at >= ${push(filters.from)}`);
  if (filters.to) where.push(`s.created_at <= ${push(filters.to)}`);
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const rows = await query(
    `select s.*, i.name as investor_name
       from sms_logs s
       left join investors i on i.id = s.investor_id
       ${whereSql} order by s.created_at desc limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const total = await query(`select count(*)::int as count from sms_logs s ${whereSql}`, params.slice(0, params.length - 2), client);
  return { rows: rows.rows, total: total.rows[0].count, limit, offset };
}

export { buildCallbackUrl };
