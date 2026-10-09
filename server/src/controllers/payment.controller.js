import { Validator, LIMITS } from '../utils/validate.js';
import { ok, created, html, csv } from '../utils/http.js';
import { badRequest, forbidden } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { toPoisha } from '../utils/money.js';
import { config } from '../config/index.js';
import * as paymentService from '../services/payment.service.js';
import * as receiptService from '../services/receipt.service.js';
import * as audit from '../services/audit.service.js';
import { paymentsCsv } from '../services/report.service.js';
import { query } from '../db/client.js';

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 200 });
  const status = req.query.status ? String(req.query.status).split(',') : undefined;
  const method = req.query.method ? String(req.query.method) : undefined;
  const result = await paymentService.listPayments({
    status,
    method,
    gateway: req.query.gateway ? String(req.query.gateway) : undefined,
    investorId: req.query.investorId ? Number(req.query.investorId) : undefined,
    investmentId: req.query.investmentId ? Number(req.query.investmentId) : undefined,
    installmentId: req.query.installmentId ? Number(req.query.installmentId) : undefined,
    from: req.query.from,
    to: req.query.to,
    paidFrom: req.query.paidFrom,
    paidTo: req.query.paidTo,
    search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    limit,
    offset,
  });
  return ok(res, { ...paged({ rows: result.rows, total: result.total, limit, offset }), successAmount: result.successAmount });
}

export async function detail(req, res) {
  const payment = await paymentService.getPayment(Number(req.params.id));
  return ok(res, { payment, receiptNumber: receiptService.receiptNumber(payment) });
}

/** POST /payments/manual - cash / bank payment recorded by an accountant. */
export async function recordManual(req, res) {
  const body = req.body ?? {};
  const v = new Validator(body);
  v.int('installmentId', { required: true, min: 1, label: 'Installment' });
  v.oneOf('method', paymentService.MANUAL_METHODS, { required: true, label: 'Payment method' });
  v.string('reference', { required: true, min: 3, max: 120, label: 'Reference number' });
  v.string('note', { required: false, max: 500, label: 'Note' });
  v.date('paidAt', { required: false, label: 'Payment date' });
  v.bool('notify', { required: false, label: 'Notify investor' });
  const input = v.result();

  const rawAmount = body.amountPoisha ?? body.amount;
  const amount = body.amountPoisha !== undefined ? Number(rawAmount) : toPoisha(rawAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('Enter a valid payment amount');

  const result = await paymentService.recordManualPayment(
    { ...input, amount, notify: input.notify ?? false },
    req.admin,
    req,
  );
  return created(res, {
    payment: result.payment,
    installment: result.installment,
    receiptNumber: receiptService.receiptNumber(result.payment),
  });
}

/** POST /payments/:id/refresh - ask the gateway for the authoritative status. */
export async function refresh(req, res) {
  const paymentId = Number(req.params.id);
  const result = await paymentService.refreshPaymentStatus(paymentId, { req, source: 'STATUS_QUERY' });
  return ok(res, { state: result.state, payment: result.payment, unchanged: Boolean(result.unchanged) });
}

export async function cancel(req, res) {
  const v = new Validator(req.body ?? {});
  v.string('reason', { required: false, max: LIMITS.reason, label: 'Reason' });
  const { reason } = v.result();
  const payment = await paymentService.cancelPayment(Number(req.params.id), { reason }, req.admin, req);
  return ok(res, { payment });
}

/** GET /payments/:id/receipt - printable HTML (print-to-PDF). */
export async function receipt(req, res) {
  const data = await receiptService.getReceiptData(Number(req.params.id));
  await audit.record({
    action: audit.AUDIT_ACTIONS.RECEIPT_VIEWED,
    entity: 'payment',
    entityId: data.receiptNumber,
    meta: { paymentId: Number(req.params.id) },
    actor: req.admin,
    req,
  });
  return html(res, receiptService.renderReceiptHtml(data, { autoPrint: String(req.query.print) === 'true' }), {
    filename: `${data.receiptNumber}.html`,
  });
}

export async function receiptJson(req, res) {
  const data = await receiptService.getReceiptData(Number(req.params.id));
  return ok(res, data);
}

export async function exportCsv(req, res) {
  const { limit, offset } = parsePagination({ ...req.query, limit: req.query.limit ?? 200 }, { defaultLimit: 200, maxLimit: 200 });
  const result = await paymentService.listPayments({
    status: req.query.status ? String(req.query.status).split(',') : undefined,
    method: req.query.method ? String(req.query.method) : undefined,
    search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    paidFrom: req.query.paidFrom,
    paidTo: req.query.paidTo,
    limit,
    offset,
  });
  const { content, filename } = paymentsCsv(result);
  await audit.record({
    action: audit.AUDIT_ACTIONS.REPORT_EXPORTED,
    entity: 'report',
    entityId: 'payments.csv',
    meta: { rows: result.rows.length },
    actor: req.admin,
    req,
  });
  return csv(res, content, filename);
}

export function providerInfo(_req, res) {
  return ok(res, {
    provider: config.payments.provider,
    mode: config.payments.provider === 'bkash' ? config.payments.bkash.mode : 'mock',
    sandbox: config.payments.provider !== 'bkash' || config.payments.bkash.mode !== 'live',
    webhookEnabled: config.payments.webhookEnabled,
    reconcileStuckAfterMinutes: config.payments.reconcileStuckAfterMinutes,
  });
}

/**
 * POST /payments/webhook - implemented but disabled unless
 * PAYMENTS_WEBHOOK_ENABLED=true. bKash's tokenized checkout does not require a
 * webhook; the callback + reconciliation job are the source of truth.
 */
export async function webhook(req, res) {
  if (!config.payments.webhookEnabled) {
    throw forbidden('Payment webhooks are disabled');
  }
  const secret = req.get('x-webhook-secret') ?? req.query.secret;
  if (config.payments.webhookSecret && secret !== config.payments.webhookSecret) {
    throw forbidden('Invalid webhook secret');
  }
  const paymentId = String(req.body?.paymentID ?? req.body?.paymentId ?? '').trim();
  if (!paymentId) throw badRequest('paymentID is required');
  const result = await paymentService.refreshPaymentStatus(Number(req.body?.internalId) || 0, { req, source: 'WEBHOOK' }).catch(async () => {
    // Fall back to a gateway-id lookup when the internal id is not supplied.
    const row = await query('select id from payments where gateway_payment_id = ?1', [paymentId]);
    if (!row.rows[0]) throw badRequest('Unknown payment');
    return paymentService.refreshPaymentStatus(row.rows[0].id, { req, source: 'WEBHOOK' });
  });
  return ok(res, { received: true, state: result.state });
}
