/**
 * Payment links.
 *
 *  token      = crypto.randomBytes(32).toString('base64url')  (256 bits, URL-safe)
 *  stored     = SHA-256(token) only, so a database leak does not expose links
 *  expiry     = configurable (PAYMENT_LINK_TTL_DAYS), enforced on every read
 *  regenerate = replaces the hash + expiry and bumps token_version, which
 *               invalidates the previously issued link immediately
 *
 * The public endpoint reveals a deliberately tiny payload: first name only,
 * installment number, amount, due date.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { config } from '../config/index.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { firstNameOnly, maskMobile } from '../utils/mask.js';
import { dhakaDate, isoDateOnly } from '../utils/dates.js';
import { generateSessionToken, hashToken } from './crypto.service.js';
import * as audit from './audit.service.js';
import { deriveStatus, outstandingPoisha } from './installment.service.js';

/** Where the investor's browser is sent. Public base URL, never a request host. */
export function buildPayUrl(token) {
  return `${config.publicBaseUrl}/pay/${token}`;
}

export function buildCallbackUrl(token) {
  const base = config.payments.bkash.callbackUrl || `${config.publicBaseUrl}/pay/callback`;
  const url = new URL(base);
  url.searchParams.set('link', token);
  return url.toString();
}

/**
 * Issue (or re-issue) a payment link for an installment.
 * Always returns the RAW token exactly once - it is never stored.
 */
export async function issueToken(installmentId, { regenerate = false, ttlDays = config.paymentLink.ttlDays, actor = null, req = null, client = null } = {}) {
  const run = async (cx) => {
    const current = await cx.query('select * from installments where id = ?1 ', [installmentId]);
    const row = current.rows[0];
    if (!row) throw notFound('Installment not found');
    if (['PAID', 'CANCELLED'].includes(row.status)) {
      throw conflict(`Cannot issue a payment link for a ${row.status.toLowerCase()} installment`);
    }
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
    const updated = await cx.query(
      `update installments
          set pay_token_hash = ?2, token_expires_at = ?3, token_issued_at = ${NOW}, updated_at = ${NOW}, token_version = token_version + 1
        where id = ?1
        returning id, serial, amount, amount_paid, due_date, status, token_expires_at, token_version`,
      [installmentId, tokenHash, expiresAt],
    );
    // "Regenerated" is a fact about what happened (a live link was replaced),
    // not merely about the request flag: issuing a link for the first time - or
    // after the previous one expired or was already replaced - is a generation.
    const replacedLiveLink =
      Boolean(row.pay_token_hash) && row.token_expires_at && new Date(row.token_expires_at).getTime() > Date.now();
    await audit.record(
      {
        action: replacedLiveLink ? audit.AUDIT_ACTIONS.PAY_LINK_REGENERATED : audit.AUDIT_ACTIONS.PAY_LINK_GENERATED,
        entity: 'installment',
        entityId: installmentId,
        oldValue: replacedLiveLink ? { token_version: row.token_version, token_expires_at: row.token_expires_at } : null,
        newValue: { token_version: updated.rows[0].token_version, token_expires_at: expiresAt.toISOString() },
        meta: { investmentId: row.investment_id, serial: row.serial, ttlDays },
        actor,
        req,
      },
      cx,
    );
    return { ...updated.rows[0], token, url: buildPayUrl(token) };
  };
  return client ? run(client) : withTransaction(run);
}

export async function regenerateToken(installmentId, actor, req) {
  const result = await issueToken(installmentId, { regenerate: true, actor, req });
  return result;
}

/**
 * Resolve a public token. Returns the installment or throws a GENERIC error -
 * invalid, expired and settled links must be indistinguishable to an attacker.
 */
export async function resolveToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new AppError(404, 'LINK_INVALID', 'This payment link is not valid or has expired');
  }
  const hash = hashToken(token);
  const res = await query(
    `select inst.*, v.investor_id, v.total_amount as investment_total, v.installment_count, v.status as investment_status,
            i.name as investor_name, i.mobile as investor_mobile, i.status as investor_status
       from installments inst
       join investments v on v.id = inst.investment_id
       join investors i on i.id = v.investor_id
      where inst.pay_token_hash = ?1`,
    [hash],
  );
  const row = res.rows[0];
  if (!row) throw new AppError(404, 'LINK_INVALID', 'This payment link is not valid or has expired');
  if (row.investment_status === 'CANCELLED') {
    throw new AppError(404, 'LINK_INVALID', 'This payment link is not valid or has expired');
  }
  if (row.token_expires_at && new Date(row.token_expires_at) <= new Date()) {
    throw new AppError(410, 'LINK_EXPIRED', 'This payment link has expired. Please ask the office for a new link.');
  }
  if (['CANCELLED'].includes(row.status)) {
    throw new AppError(404, 'LINK_INVALID', 'This payment link is not valid or has expired');
  }
  return row;
}

/** Public projection for GET /api/public/pay/:token (minimal, no PII). */
export function publicView(installment) {
  const today = dhakaDate();
  const effective = deriveStatus(installment, today);
  const settled = ['PAID', 'WAIVED', 'CANCELLED'].includes(effective);
  return {
    firstName: firstNameOnly(installment.investor_name),
    installmentNumber: installment.serial,
    installmentCount: installment.installment_count,
    investmentTotal: Number(installment.investment_total),
    amount: outstandingPoisha(installment) || Number(installment.amount),
    amountPaid: Number(installment.amount_paid),
    dueDate: isoDateOnly(installment.due_date),
    status: effective,
    overdue: effective === 'OVERDUE',
    settled,
    canPay: !settled,
    linkExpiresAt: installment.token_expires_at,
    mobileHint: maskMobile(installment.investor_mobile),
    businessName: config.totp.issuer,
  };
}

export async function tokenStatus(token) {
  const row = await resolveToken(token);
  return publicView(row);
}
