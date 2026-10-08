import { Validator, LIMITS } from '../utils/validate.js';
import { ok } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { dhakaDate } from '../utils/dates.js';
import { toPoisha } from '../utils/money.js';
import * as installmentService from '../services/installment.service.js';
import * as paylinkService from '../services/paylink.service.js';
import { sendPaymentLink } from '../services/sms.service.js';
import { query } from '../db/pool.js';

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 200 });
  const status = req.query.status ? String(req.query.status).split(',') : undefined;
  const result = await installmentService.listInstallments({
    investmentId: req.query.investmentId ? Number(req.query.investmentId) : undefined,
    investorId: req.query.investorId ? Number(req.query.investorId) : undefined,
    status,
    openOnly: String(req.query.openOnly) === 'true',
    dueFrom: req.query.dueFrom,
    dueTo: req.query.dueTo,
    overdueAsOf: String(req.query.overdue) === 'true' ? dhakaDate() : undefined,
    search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    sort: req.query.sort,
    dir: req.query.dir,
    limit,
    offset,
  });
  const today = dhakaDate();
  return ok(
    res,
    paged({
      rows: result.rows.map((r) => ({ ...r, effective_status: installmentService.deriveStatus(r, today) })),
      total: result.total,
      limit,
      offset,
    }),
  );
}

export async function detail(req, res) {
  const installment = await installmentService.getInstallment(Number(req.params.id));
  const payments = await query(
    `select id, amount, status, method, gateway, trx_id, manual_reference, paid_at, created_at, failure_reason
       from payments where installment_id = $1 order by created_at desc`,
    [installment.id],
  );
  const sms = await query(
    `select id, message_type, provider_status, created_at, mobile_masked from sms_logs
      where installment_id = $1 order by created_at desc limit 20`,
    [installment.id],
  );
  const today = dhakaDate();
  return ok(res, {
    installment: { ...installment, effective_status: installmentService.deriveStatus(installment, today) },
    payments: payments.rows,
    sms: sms.rows,
  });
}

export async function update(req, res) {
  const body = req.body ?? {};
  const v = new Validator(body);
  v.date('due_date', { required: false, label: 'Due date' });
  const changes = {};
  const rawAmount = body.amountPoisha ?? body.amount;
  if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
    const poisha = body.amountPoisha !== undefined ? Number(rawAmount) : toPoisha(rawAmount);
    if (!Number.isSafeInteger(poisha) || poisha <= 0) throw badRequest('Enter a valid installment amount');
    changes.amount = poisha;
  }
  const parsed = v.result();
  if (parsed.due_date) changes.due_date = parsed.due_date;
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update');
  const updated = await installmentService.updateInstallment(Number(req.params.id), changes, req.admin, req);
  return ok(res, { installment: updated });
}

export async function setState(req, res) {
  const v = new Validator(req.body);
  v.oneOf('status', ['WAIVED', 'CANCELLED', 'PENDING'], { required: true, label: 'Status' });
  v.string('reason', { required: false, max: LIMITS.reason, label: 'Reason' });
  const { status, reason } = v.result();
  if (['WAIVED', 'CANCELLED'].includes(status) && (!reason || reason.trim().length < 3)) {
    throw badRequest('A reason is required to waive or cancel an installment');
  }
  const updated = await installmentService.changeInstallmentState(Number(req.params.id), { status, reason }, req.admin, req);
  return ok(res, { installment: updated });
}

/** POST /installments/:id/pay-link  { regenerate?: boolean, send?: boolean } */
export async function issuePayLink(req, res) {
  const id = Number(req.params.id);
  const regenerate = String(req.body?.regenerate ?? 'false') === 'true';
  const send = String(req.body?.send ?? 'false') === 'true';
  const issued = await paylinkService.issueToken(id, { regenerate, actor: req.admin, req });
  let sms = null;
  if (send) {
    const installment = await installmentService.getInstallment(id);
    sms = await sendPaymentLink({ installment, token: issued.token, url: issued.url, actor: req.admin, req });
  }
  return ok(res, {
    installmentId: id,
    url: issued.url,
    tokenExpiresAt: issued.token_expires_at,
    tokenVersion: issued.token_version,
    // The raw token is returned once so an admin can copy the link manually.
    token: issued.token,
    sms,
  });
}

/** POST /installments/:id/send-link (explicit SMS-only action) */
export async function sendLink(req, res) {
  const id = Number(req.params.id);
  const issued = await paylinkService.issueToken(id, { regenerate: false, actor: req.admin, req });
  const installment = await installmentService.getInstallment(id);
  const sms = await sendPaymentLink({ installment, token: issued.token, url: issued.url, actor: req.admin, req });
  return ok(res, { sent: sms.ok, url: issued.url, sms });
}

/** POST /installments/bulk/send-links { ids: number[] } */
export async function bulkSendLinks(req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) throw badRequest('Select at least one installment');
  if (ids.length > 50) throw badRequest('Send at most 50 links at a time');
  const results = [];
  for (const id of ids) {
    try {
      const issued = await paylinkService.issueToken(id, { regenerate: false, actor: req.admin, req });
      const installment = await installmentService.getInstallment(id);
      const sms = await sendPaymentLink({ installment, token: issued.token, url: issued.url, actor: req.admin, req });
      results.push({ id, sent: sms.ok, url: issued.url, mobile: installment.investor_mobile, serial: installment.serial });
    } catch (err) {
      results.push({ id, sent: false, error: err?.message ?? 'failed' });
    }
  }
  return ok(res, { requested: ids.length, sent: results.filter((r) => r.sent).length, results });
}

