/**
 * Investor portal handlers (mounted at /api/portal).
 *
 * Identity always comes from the investor session (req.investor) - there is
 * no :id in any portal URL, so an investor cannot even address another
 * investor's data.
 */
import { Validator, LIMITS } from '../utils/validate.js';
import { ok, binary, html, csv } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import { INVESTOR_PASSWORD_MIN_LENGTH } from '../services/crypto.service.js';
import * as investorAuth from '../services/investor-auth.service.js';
import * as portalService from '../services/investor-portal.service.js';
import * as investorService from '../services/investor.service.js';
import * as receiptService from '../services/receipt.service.js';
import * as reportService from '../services/report.service.js';
import * as audit from '../services/audit.service.js';
import { setInvestorSessionCookie, clearInvestorSessionCookie } from '../middleware/investor-auth.js';
import { applyProfileValidators, INSTALLMENT_STATUS_FILTERS } from './investor.controller.js';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
/** POST /api/portal/auth/login  { loginId, password } */
export async function login(req, res) {
  const v = new Validator(req.body);
  v.string('loginId', { required: true, max: 60, label: 'Mobile number or member code' });
  v.string('password', { required: true, max: LIMITS.password.max, label: 'Password' });
  const input = v.result();

  const investor = await investorAuth.login(input, req);
  const session = await investorAuth.createInvestorSession(investor, req);
  setInvestorSessionCookie(res, session.token);

  return ok(res, {
    investor: investorAuth.publicPortalInvestor(investor),
    expiresAt: session.expiresAt,
  });
}

/** POST /api/portal/auth/logout */
export async function logout(req, res) {
  if (req.investorSession) {
    await investorAuth.revokeInvestorSession(req.investorSession.sessionId, 'LOGOUT');
    await audit.record({
      action: audit.AUDIT_ACTIONS.INVESTOR_LOGOUT,
      entity: 'investor',
      entityId: req.investor?.id ?? null,
      meta: { self: true },
      req,
    });
  }
  clearInvestorSessionCookie(res);
  return ok(res, { loggedOut: true });
}

/** GET /api/portal/auth/me */
export async function me(req, res) {
  const sessions = await investorAuth.listInvestorSessions(req.investor.id);
  return ok(res, {
    investor: investorAuth.publicPortalInvestor(req.investor),
    session: { id: req.investorSession?.sessionId ?? null, expiresAt: req.investorSession?.expiresAt ?? null },
    sessions: sessions.slice(0, 10).map((s) => ({ ...s, current: s.id === req.investorSession?.sessionId })),
  });
}

/** POST /api/portal/auth/change-password */
export async function changePassword(req, res) {
  const v = new Validator(req.body);
  v.string('currentPassword', { required: true, max: LIMITS.password.max, label: 'Current password' });
  v.string('newPassword', {
    required: true,
    min: INVESTOR_PASSWORD_MIN_LENGTH,
    max: LIMITS.password.max,
    label: 'New password',
  });
  const input = v.result();
  await investorAuth.changeOwnPassword(req.investor.id, input, req);
  await investorAuth.revokeAllInvestorSessions(req.investor.id, {
    exceptSessionId: req.investorSession.sessionId,
    reason: 'PASSWORD_CHANGED',
  });
  return ok(res, { changed: true });
}

/** POST /api/portal/auth/sessions/revoke-others */
export async function revokeOtherSessions(req, res) {
  await investorAuth.revokeAllInvestorSessions(req.investor.id, { exceptSessionId: req.investorSession.sessionId });
  await audit.record({
    action: audit.AUDIT_ACTIONS.INVESTOR_SESSIONS_REVOKED,
    entity: 'investor',
    entityId: req.investor.id,
    meta: { scope: 'OTHERS', self: true },
    req,
  });
  return ok(res, { revoked: true });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
export async function dashboard(req, res) {
  return ok(res, await portalService.getDashboard(req.investor.id));
}

export async function profile(req, res) {
  return ok(res, await portalService.getOwnProfile(req.investor.id));
}

export async function updateProfile(req, res) {
  const v = new Validator(req.body);
  applyProfileValidators(v);
  const changes = v.result();
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update');
  return ok(res, await portalService.updateOwnProfile(req.investor.id, changes, req));
}

export async function investments(req, res) {
  return ok(res, { investments: await portalService.listOwnInvestments(req.investor.id) });
}

export async function installments(req, res) {
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !INSTALLMENT_STATUS_FILTERS.includes(status)) throw badRequest('Invalid status filter');
  const rows = await portalService.listOwnInstallments(req.investor.id, { status });
  return ok(res, { installments: rows });
}

export async function payments(req, res) {
  const rows = await portalService.listOwnPayments(req.investor.id, {});
  return ok(res, { payments: rows });
}

/** POST /api/portal/installments/:id/pay-link - own installments only. */
export async function payLink(req, res) {
  const link = await portalService.issueOwnPayLink(req.investor.id, Number(req.params.id), req);
  return ok(res, link);
}

// ---------------------------------------------------------------------------
// Documents (own photo / NID scan)
// ---------------------------------------------------------------------------
export async function getPhoto(req, res) {
  const file = await investorService.getPhoto(req.investor.id);
  return binary(res, file.buffer, { mime: file.mime, cache: 'private, max-age=300' });
}

export async function uploadPhoto(req, res) {
  const result = await investorService.setPhoto(req.investor.id, req.body, null, req, { selfService: true });
  return ok(res, result);
}

export async function getNidScan(req, res) {
  const file = await investorService.getNidScan(req.investor.id, null, req, { selfService: true });
  return binary(res, file.buffer, { mime: file.mime });
}

export async function uploadNidScan(req, res) {
  const result = await investorService.setNidScan(req.investor.id, req.body, null, req, { selfService: true });
  return ok(res, result);
}

// ---------------------------------------------------------------------------
// Receipt + statement (own records only)
// ---------------------------------------------------------------------------
export async function receipt(req, res) {
  const paymentId = Number(req.params.id);
  await portalService.assertOwnPayment(req.investor.id, paymentId);
  const data = await receiptService.getReceiptData(paymentId);
  if (data.status !== 'SUCCESS') throw badRequest('Receipt is available after a successful payment');
  await audit.record({
    action: audit.AUDIT_ACTIONS.RECEIPT_VIEWED,
    entity: 'payment',
    entityId: data.receiptNumber,
    meta: { self: true, investorId: req.investor.id },
    req,
  });
  return html(res, receiptService.renderReceiptHtml(data, { autoPrint: String(req.query.print) === 'true' }), {
    filename: `${data.receiptNumber}.html`,
  });
}

export async function statementCsv(req, res) {
  const statement = await reportService.investorStatement({ investorId: req.investor.id });
  const { content, filename } = reportService.statementCsv(statement);
  await audit.record({
    action: audit.AUDIT_ACTIONS.REPORT_EXPORTED,
    entity: 'investor',
    entityId: req.investor.id,
    meta: { kind: 'statement_csv', self: true, filename },
    req,
  });
  return csv(res, content, filename);
}
