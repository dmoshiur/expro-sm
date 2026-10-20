/**
 * Donates handlers.
 *   * portal (investor session): overview, start, verify, own receipt
 *   * gateway callback (public redirect target, shared with installments)
 *   * staff list (read-only, any signed-in admin)
 */
import { Validator } from '../utils/validate.js';
import { ok, created, html } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import * as donationService from '../services/donation.service.js';
import * as receiptService from '../services/receipt.service.js';
import * as audit from '../services/audit.service.js';

/** GET /api/portal/donations */
export async function overview(req, res) {
  return ok(res, await donationService.donationOverview(req.investor.id));
}

/** POST /api/portal/donations { fundCode, amount } */
export async function create(req, res) {
  const v = new Validator(req.body ?? {});
  v.string('fundCode', { required: true, max: 40, label: 'Fund' });
  const input = v.result();
  const result = await donationService.createDonation(
    { investorId: req.investor.id, fundCode: input.fundCode, amountTaka: req.body?.amount },
    req,
  );
  return created(res, {
    donation: result.donation,
    redirectUrl: result.redirectUrl,
    paymentId: result.paymentId,
    reused: result.reused,
    provider: config.payments.provider,
  });
}

/** GET /api/portal/donations/:id */
export async function detail(req, res) {
  return ok(res, { donation: await donationService.getOwnDonation(req.investor.id, Number(req.params.id)) });
}

/** POST /api/portal/donations/:id/verify - the browser is not trusted; the gateway is re-queried. */
export async function verify(req, res) {
  const result = await donationService.verifyOwnDonation(req.investor.id, Number(req.params.id), req);
  return ok(res, result);
}

/** GET /api/portal/donations/:id/receipt - successful donations only. */
export async function receipt(req, res) {
  const data = await donationService.getDonationReceiptData(req.investor.id, Number(req.params.id));
  await audit.record({
    action: audit.AUDIT_ACTIONS.DONATION_RECEIPT_VIEWED,
    entity: 'donation',
    entityId: data.id,
    meta: { self: true, investorId: req.investor.id },
    req,
  });
  return html(res, receiptService.renderDonationReceiptHtml(data, { autoPrint: String(req.query.print) === 'true' }), {
    filename: `${data.receipt_number}.html`,
  });
}

/**
 * GET /pay/callback?kind=donation&paymentID=...
 * Redirect target for donation payments. Status query parameters are ignored;
 * the payment id is re-checked with the gateway by the service.
 */
export async function gatewayCallback(req, res) {
  const target = '/portal/donates/result';
  const paymentId = String(req.query.paymentID ?? req.query.paymentId ?? '').trim();
  if (!paymentId) {
    logger.warn('donation callback without paymentID', { ip: req.clientIp });
    return res.redirect(303, `${target}?state=error&reason=missing_payment`);
  }
  try {
    const result = await donationService.handleDonationCallback({ paymentId, req });
    const ref = encodeURIComponent(result.donation?.id ?? '');
    return res.redirect(303, `${target}?state=${encodeURIComponent(result.state)}&ref=${ref}`);
  } catch (err) {
    logger.error('donation callback failed', { err, ip: req.clientIp });
    const reason = err?.code === 'NOT_FOUND' ? 'unknown_payment' : 'verification_failed';
    return res.redirect(303, `${target}?state=error&reason=${reason}`);
  }
}

/** GET /api/donations (staff, read-only) */
export async function list(req, res) {
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !donationService.DONATION_STATUSES.includes(status)) throw badRequest('Invalid status filter');
  const fund = req.query.fund ? String(req.query.fund) : null;
  if (fund && !donationService.fundByCode(fund)) throw badRequest('Unknown fund');
  const result = await donationService.listDonations({
    status,
    fundCode: fund,
    search: req.query.search ? String(req.query.search).slice(0, 100) : null,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  return ok(res, result);
}
