/**
 * Investor portal handlers (mounted at /api/portal).
 *
 * Identity always comes from the investor session (req.investor) - there is
 * no :id in any portal URL, so an investor cannot even address another
 * investor's data.
 */
import { Validator, LIMITS } from '../utils/validate.js';
import { ok, created, binary, html, csv } from '../utils/http.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { config } from '../config/index.js';
import { INVESTOR_PASSWORD_MIN_LENGTH } from '../services/crypto.service.js';
import * as investorAuth from '../services/investor-auth.service.js';
import * as portalService from '../services/investor-portal.service.js';
import * as investorService from '../services/investor.service.js';
import { IDENTITY_LOCKED_FIELDS } from '../services/investor-portal.service.js';
import * as receiptService from '../services/receipt.service.js';
import * as reportService from '../services/report.service.js';
import * as walletService from '../services/wallet.service.js';
import * as documentService from '../services/document.service.js';
import * as alertsService from '../services/alerts.service.js';
import * as supportService from '../services/support.service.js';
import * as certificateService from '../services/certificate.service.js';
import * as audit from '../services/audit.service.js';
import { setInvestorSessionCookie, clearInvestorSessionCookie } from '../middleware/investor-auth.js';
import { applyProfileValidators, parseTakaAmount, INSTALLMENT_STATUS_FILTERS } from './investor.controller.js';

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

/**
 * Own profile = profile + completion + document slots + live alerts + wallet
 * snapshot, so the tabbed profile page needs exactly one request.
 */
export async function profile(req, res) {
  const data = await portalService.getOwnProfile(req.investor.id);
  const [documents, alerts, wallet] = await Promise.all([
    documentService.listDocuments(req.investor.id),
    alertsService.getInvestorAlerts(req.investor.id),
    walletService.getWalletSummary(req.investor.id),
  ]);
  return ok(res, { ...data, documents, alerts, wallet });
}

/**
 * PATCH /api/portal/profile - contact and personal details only. Any identity
 * field (name, mobile, date of birth, parents' names, NID, status) is refused
 * with 403 FIELD_LOCKED and the attempt is audited.
 */
export async function updateProfile(req, res) {
  const attempted = IDENTITY_LOCKED_FIELDS.filter((field) => req.body?.[field] !== undefined);
  if (attempted.length) {
    await audit.record({
      action: audit.AUDIT_ACTIONS.PORTAL_LOCKED_FIELD_BLOCKED,
      entity: 'investor',
      entityId: req.investor.id,
      meta: { self: true, investorId: req.investor.id, fields: attempted },
      req,
    });
    throw new AppError(
      403,
      'FIELD_LOCKED',
      'These details are set by the office and cannot be changed in the portal. Open a support inquiry to request a change.',
      { fields: attempted },
    );
  }
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
// Wallet (self-service requests + ledger)
// ---------------------------------------------------------------------------
export async function wallet(req, res) {
  return ok(res, await walletService.getWallet(req.investor.id));
}

/** POST /api/portal/wallet/requests { type, amount, method?, reference?, note? } */
export async function requestWalletTransaction(req, res) {
  const v = new Validator(req.body);
  v.oneOf('type', walletService.WALLET_REQUEST_TYPES, { required: true, label: 'Request type' });
  v.oneOf('method', walletService.WALLET_METHODS, { required: false, label: 'Method' });
  v.string('reference', { required: false, max: 120, label: 'Reference' });
  v.string('note', { required: false, max: 500, label: 'Note' });
  const input = v.result();
  const amount = parseTakaAmount(req.body?.amount);
  const result = await walletService.requestTransaction(
    req.investor.id,
    { type: input.type, amount, method: input.method ?? null, externalReference: input.reference ?? null, note: input.note ?? null },
    req,
  );
  return created(res, result);
}

// ---------------------------------------------------------------------------
// Documents (read-only for investors): own photo / NID / signature slots + nominee photos
// ---------------------------------------------------------------------------
export async function documents(req, res) {
  return ok(res, await documentService.listDocuments(req.investor.id));
}

/** GET /api/portal/documents/:kind/file */
export async function ownDocumentFile(req, res) {
  const kind = String(req.params.kind ?? '').toUpperCase();
  if (!documentService.DOCUMENT_KINDS.includes(kind)) throw badRequest('Unknown document kind');
  const file = await documentService.getDocumentFile(req.investor.id, kind, { req, selfService: true });
  return binary(res, file.buffer, { mime: file.mime, cache: 'private, max-age=60' });
}

/** GET /api/portal/nominees/:nomineeId/photo */
export async function ownNomineePhotoFile(req, res) {
  const file = await documentService.getDocumentFile(req.investor.id, 'NOMINEE_PHOTO', {
    req,
    selfService: true,
    nomineeId: Number(req.params.nomineeId),
  });
  return binary(res, file.buffer, { mime: file.mime, cache: 'private, max-age=60' });
}

// ---------------------------------------------------------------------------
// Support / inquiries (own tickets only)
// ---------------------------------------------------------------------------
export async function supportTickets(req, res) {
  return ok(res, { tickets: await supportService.listOwnTickets(req.investor.id) });
}

export async function createSupportTicket(req, res) {
  const v = new Validator(req.body);
  v.string('subject', { required: true, min: 3, max: 160, label: 'Subject' });
  v.oneOf('category', supportService.TICKET_CATEGORIES, { required: false, label: 'Category' });
  v.oneOf('priority', supportService.TICKET_PRIORITIES, { required: false, label: 'Priority' });
  v.string('message', { required: true, min: 1, max: 4000, label: 'Message' });
  const input = v.result();
  return created(res, await supportService.createTicket(req.investor.id, input, req));
}

export async function supportTicket(req, res) {
  return ok(res, await supportService.getOwnTicket(req.investor.id, Number(req.params.id)));
}

export async function replySupportTicket(req, res) {
  const v = new Validator(req.body);
  v.string('message', { required: true, min: 1, max: 4000, label: 'Message' });
  const { message } = v.result();
  return ok(res, await supportService.addOwnMessage(req.investor.id, Number(req.params.id), { body: message }, req));
}

export async function closeSupportTicket(req, res) {
  return ok(res, await supportService.closeOwnTicket(req.investor.id, Number(req.params.id), req));
}

// ---------------------------------------------------------------------------
// Printable documents: membership certificate + investment statement
// ---------------------------------------------------------------------------
export async function certificate(req, res) {
  const data = await certificateService.getCertificateData(req.investor.id);
  if (!data) throw notFound('Investor not found');
  await audit.record({
    action: audit.AUDIT_ACTIONS.CERTIFICATE_VIEWED,
    entity: 'investor',
    entityId: req.investor.id,
    meta: { self: true, certificate: data.certificateNo },
    req,
  });
  return html(res, certificateService.renderCertificateHtml(data, { autoPrint: String(req.query.print) === 'true' }), {
    filename: `${data.certificateNo}.html`,
  });
}

export async function statementHtml(req, res) {
  const statement = await reportService.investorStatement({ investorId: req.investor.id });
  if (!statement) throw notFound('Investor not found');
  const walletSummary = await walletService.getWalletSummary(req.investor.id);
  await audit.record({
    action: audit.AUDIT_ACTIONS.REPORT_EXPORTED,
    entity: 'investor',
    entityId: req.investor.id,
    meta: { kind: 'statement_html', self: true },
    req,
  });
  return html(
    res,
    certificateService.renderStatementHtml(statement, {
      wallet: walletSummary,
      business: { name: config.totp.issuer, baseUrl: config.publicBaseUrl },
      autoPrint: String(req.query.print) === 'true',
    }),
    { filename: `statement-${req.investor.id}.html` },
  );
}

// ---------------------------------------------------------------------------
// Documents (own photo / NID scan, read-only)
// ---------------------------------------------------------------------------
export async function getPhoto(req, res) {
  const file = await investorService.getPhoto(req.investor.id);
  return binary(res, file.buffer, { mime: file.mime, cache: 'private, max-age=300' });
}

export async function getNidScan(req, res) {
  const file = await investorService.getNidScan(req.investor.id, null, req, { selfService: true });
  return binary(res, file.buffer, { mime: file.mime });
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
