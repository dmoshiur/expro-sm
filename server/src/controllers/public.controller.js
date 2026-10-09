/**
 * Investor-facing endpoints. No session, no CORS, protected by the payment
 * token itself plus rate limiting. Only the minimal payload is exposed.
 */
import { Validator } from '../utils/validate.js';
import { ok, html } from '../utils/http.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import * as paylink from '../services/paylink.service.js';
import * as paymentService from '../services/payment.service.js';
import { summarizePaymentForPublic, getPayment } from '../services/payment.service.js';
import * as audit from '../services/audit.service.js';
import { config } from '../config/index.js';

/** GET /api/public/pay/:token */
export async function viewLink(req, res) {
  const token = String(req.params.token ?? '');
  let installment;
  try {
    installment = await paylink.resolveToken(token);
  } catch (err) {
    await audit.record({
      action: audit.AUDIT_ACTIONS.PAY_LINK_INVALID,
      entity: 'installment',
      entityId: null,
      meta: { reason: err?.code ?? 'INVALID', ip: req.clientIp },
      req,
    });
    throw err;
  }
  await audit.record({
    action: audit.AUDIT_ACTIONS.PAY_LINK_ACCESSED,
    entity: 'installment',
    entityId: installment.id,
    meta: { serial: installment.serial, investmentId: installment.investment_id },
    req,
  });
  return ok(res, paylink.publicView(installment));
}

/** POST /api/public/pay/:token/start -> { redirectUrl } */
export async function startPayment(req, res) {
  const v = new Validator(req.body ?? {});
  v.string('mobile', { required: false, max: 20, label: 'Mobile number' });
  const { mobile } = v.result();
  const token = String(req.params.token ?? '');
  const result = await paymentService.startPayment({ token, req, payerMobile: mobile ?? null });
  return ok(res, {
    redirectUrl: result.redirectUrl,
    paymentId: result.paymentId,
    amount: result.amount,
    provider: config.payments.provider,
  });
}

/**
 * POST /api/public/pay/:token/verify { paymentId }
 * Used by the result page. The server talks to the gateway; the browser is
 * never trusted about the outcome.
 */
export async function verifyPayment(req, res) {
  const v = new Validator(req.body ?? {});
  v.string('paymentId', { required: true, max: 80, label: 'Payment id' });
  const { paymentId } = v.result();
  const token = String(req.params.token ?? '');
  const installment = await paylink.resolveToken(token);
  const payment = await getPaymentByGateway(paymentId);
  if (!payment) throw notFound('Payment not found');
  if (Number(payment.installment_id) !== Number(installment.id)) {
    throw badRequest('Payment does not belong to this link');
  }

  let state = payment.status.toLowerCase();
  try {
    const refreshed = await paymentService.refreshPaymentStatus(payment.id, { req, source: 'STATUS_QUERY' });
    state = refreshed.state ?? state;
  } catch (err) {
    logger.warn('verify payment failed', { err, paymentId });
    if (err instanceof AppError) throw err;
  }
  const fresh = await getPayment(payment.id);
  const updatedInstallment = await paylink.resolveToken(token).catch(() => null);
  return ok(res, {
    payment: summarizePaymentForPublic(fresh),
    installment: updatedInstallment ? paylink.publicView(updatedInstallment) : null,
    state,
  });
}

async function getPaymentByGateway(gatewayPaymentId) {
  const { query } = await import('../db/pool.js');
  const res = await query('select * from payments where gateway_payment_id = $1', [gatewayPaymentId]);
  return res.rows[0] ?? null;
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * GET /pay/callback?link=<token>&paymentID=...
 * The gateway redirects the investor's browser here. We ignore every status
 * query parameter, re-execute/re-query with the gateway and then redirect the
 * browser to the SPA result page. Idempotent: replaying the callback is a no-op.
 */
export async function gatewayCallback(req, res) {
  const linkToken = String(req.query.link ?? '');
  const paymentId = String(req.query.paymentID ?? req.query.paymentId ?? '').trim();
  const target = linkToken ? `/pay/${linkToken}/result` : '/pay/result';

  if (!paymentId) {
    logger.warn('callback without paymentID', { ip: req.clientIp });
    return res.redirect(303, `${target}?state=error&reason=missing_payment`);
  }

  try {
    const result = await paymentService.handleCallback({ linkToken, paymentId, req });
    const state = result.state === 'success' ? 'success' : result.state === 'pending' ? 'pending' : result.state;
    const ref = encodeURIComponent(result.payment?.id ?? '');
    return res.redirect(303, `${target}?state=${state}&ref=${ref}&paymentID=${encodeURIComponent(paymentId)}`);
  } catch (err) {
    logger.error('payment callback failed', { err, paymentId, ip: req.clientIp });
    const reason = err?.code === 'NOT_FOUND' ? 'unknown_payment' : 'verification_failed';
    return res.redirect(303, `${target}?state=error&reason=${reason}&paymentID=${encodeURIComponent(paymentId)}`);
  }
}

/** GET /pay/:token/result is part of the SPA; this renders a plain fallback. */
export async function resultFallback(req, res) {
  const state = String(req.query.state ?? 'unknown');
  return html(
    res,
    `<!doctype html><meta charset="utf-8"><title>Payment ${esc(state)}</title>` +
      '<body style="font-family:system-ui;padding:2rem;max-width:36rem;margin:auto">' +
      `<h1>Payment ${esc(state)}</h1><p>You can close this page and return to the app.</p></body>`,
  );
}
