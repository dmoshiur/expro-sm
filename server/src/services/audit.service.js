/**
 * Audit trail. Every create/update/delete/login/failed-login/role change/
 * payment record/link regeneration goes through here, FROM THE SERVICE LAYER,
 * with old + new values. audit_logs is append-only at the database level.
 */
import { query } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { maskMobile } from '../utils/mask.js';

export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGIN_LOCKED: 'LOGIN_LOCKED',
  LOGOUT: 'LOGOUT',
  SESSION_REFRESHED: 'SESSION_REFRESHED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  TOTP_SETUP_STARTED: 'TOTP_SETUP_STARTED',
  TOTP_ENABLED: 'TOTP_ENABLED',
  TOTP_DISABLED: 'TOTP_DISABLED',
  TOTP_VERIFY_FAILED: 'TOTP_VERIFY_FAILED',
  ADMIN_CREATED: 'ADMIN_CREATED',
  ADMIN_UPDATED: 'ADMIN_UPDATED',
  ADMIN_ROLE_CHANGED: 'ADMIN_ROLE_CHANGED',
  ADMIN_DISABLED: 'ADMIN_DISABLED',
  ADMIN_ENABLED: 'ADMIN_ENABLED',
  INVESTOR_CREATED: 'INVESTOR_CREATED',
  INVESTOR_UPDATED: 'INVESTOR_UPDATED',
  INVESTOR_DEACTIVATED: 'INVESTOR_DEACTIVATED',
  INVESTOR_RESTORED: 'INVESTOR_RESTORED',
  INVESTOR_DELETED: 'INVESTOR_DELETED',
  INVESTOR_PHOTO_UPDATED: 'INVESTOR_PHOTO_UPDATED',
  INVESTOR_NID_UPDATED: 'INVESTOR_NID_UPDATED',
  INVESTOR_NID_VIEWED: 'INVESTOR_NID_VIEWED',
  NOMINEES_REPLACED: 'NOMINEES_REPLACED',
  NOMINEE_UPDATED: 'NOMINEE_UPDATED',
  INVESTMENT_CREATED: 'INVESTMENT_CREATED',
  INVESTMENT_UPDATED: 'INVESTMENT_UPDATED',
  INVESTMENT_TOTAL_CHANGED: 'INVESTMENT_TOTAL_CHANGED',
  INVESTMENT_STATUS_CHANGED: 'INVESTMENT_STATUS_CHANGED',
  INSTALLMENT_UPDATED: 'INSTALLMENT_UPDATED',
  INSTALLMENT_WAIVED: 'INSTALLMENT_WAIVED',
  INSTALLMENT_CANCELLED: 'INSTALLMENT_CANCELLED',
  INSTALLMENT_REINSTATED: 'INSTALLMENT_REINSTATED',
  INSTALLMENT_OVERDUE_MARKED: 'INSTALLMENT_OVERDUE_MARKED',
  PAYMENT_LOAD_ALERT: 'PAYMENT_LOAD_ALERT',
  PAY_LINK_GENERATED: 'PAY_LINK_GENERATED',
  PAY_LINK_REGENERATED: 'PAY_LINK_REGENERATED',
  PAY_LINK_ACCESSED: 'PAY_LINK_ACCESSED',
  PAY_LINK_INVALID: 'PAY_LINK_INVALID',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_VERIFIED: 'PAYMENT_VERIFIED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_CANCELLED: 'PAYMENT_CANCELLED',
  PAYMENT_MANUAL_RECORDED: 'PAYMENT_MANUAL_RECORDED',
  PAYMENT_RECONCILED: 'PAYMENT_RECONCILED',
  RECEIPT_VIEWED: 'RECEIPT_VIEWED',
  SMS_SENT: 'SMS_SENT',
  SMS_FAILED: 'SMS_FAILED',
  REMINDER_SENT: 'REMINDER_SENT',
  JOB_RUN: 'JOB_RUN',
  REPORT_EXPORTED: 'REPORT_EXPORTED',
  UNAUTHORIZED_ATTEMPT: 'UNAUTHORIZED_ATTEMPT',
};

const REDACTED_KEYS = new Set([
  'password',
  'password_hash',
  'current_password',
  'new_password',
  'confirm_password',
  'totp_secret',
  'token',
  'token_hash',
  'pay_token',
  'pay_token_hash',
  'nid_encrypted',
  'nid_scan',
  'nid_hash',
  'photo',
  'api_key',
  'raw_response',
]);

/** Depth-limited redaction so audit rows never store secrets or raw NID/scan. */
export function redactForAudit(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForAudit(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACTED_KEYS.has(k)) {
      out[k] = v === null || v === undefined ? null : '[redacted]';
      continue;
    }
    if (k === 'mobile' && typeof v === 'string' && /^01[3-9]\d{8}$/.test(v)) {
      out[k] = maskMobile(v);
      continue;
    }
    out[k] = redactForAudit(v, depth + 1);
  }
  return out;
}

function requestMeta(req) {
  if (!req) return {};
  return {
    ip: req.clientIp ?? null,
    userAgent: String(req.get?.('user-agent') ?? '').slice(0, 400) || null,
    requestId: req.id ?? null,
  };
}

/**
 * Append an audit row. Never throws: an audit failure must not break a business
 * operation, but it is logged loudly.
 */
export async function record(entry, client = undefined) {
  try {
    const { adminId = null, actor = null, action, entity, entityId = null, oldValue = null, newValue = null, meta = null, req = null } = entry;
    const meta2 = requestMeta(req);
    const sql = `
      insert into audit_logs
        (admin_id, actor_email, actor_role, action, entity, entity_id, old_value, new_value, meta, ip, user_agent, request_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      returning id`;
    const params = [
      adminId ?? actor?.id ?? null,
      actor?.email ?? null,
      actor?.role ?? null,
      String(action),
      String(entity),
      entityId === null || entityId === undefined ? null : String(entityId),
      oldValue === null ? null : JSON.stringify(redactForAudit(oldValue)),
      newValue === null ? null : JSON.stringify(redactForAudit(newValue)),
      meta === null ? null : JSON.stringify(redactForAudit(meta)),
      meta2.ip,
      meta2.userAgent,
      meta2.requestId,
    ];
    const res = await query(sql, params, client);
    return res.rows[0]?.id ?? null;
  } catch (err) {
    logger.error('audit write failed', { err, action: entry?.action, entity: entry?.entity });
    return null;
  }
}

export async function list(filters = {}, client = undefined) {
  const where = [];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.adminId) where.push(`a.admin_id = ${push(filters.adminId)}`);
  if (filters.action) where.push(`a.action = ${push(filters.action)}`);
  if (filters.entity) where.push(`a.entity = ${push(filters.entity)}`);
  if (filters.entityId) where.push(`a.entity_id = ${push(String(filters.entityId))}`);
  if (filters.from) where.push(`a.created_at >= ${push(filters.from)}`);
  if (filters.to) where.push(`a.created_at <= ${push(filters.to)}`);
  if (filters.search) {
    const term = `%${String(filters.search).toLowerCase()}%`;
    where.push(`(lower(a.actor_email) like ${push(term)} or lower(a.action) like $${params.length} or lower(a.entity) like $${params.length})`);
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const rows = await query(
    `select a.*, ad.name as actor_name
       from audit_logs a
       left join admins ad on ad.id = a.admin_id
       ${whereSql}
       order by a.created_at desc, a.id desc
       limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const total = await query(`select count(*)::int as count from audit_logs a ${whereSql}`, params.slice(0, params.length - 2), client);
  return { rows: rows.rows, total: total.rows[0].count, limit, offset };
}

export async function distinctValues(client = undefined) {
  const [actions, entities] = await Promise.all([
    query('select distinct action from audit_logs order by action', [], client),
    query('select distinct entity from audit_logs order by entity', [], client),
  ]);
  return { actions: actions.rows.map((r) => r.action), entities: entities.rows.map((r) => r.entity) };
}
