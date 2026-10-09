import { Validator, LIMITS } from '../utils/validate.js';
import { ok, created } from '../utils/http.js';
import { badRequest } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { isPositiveInt } from '../utils/money.js';
import { dhakaDate } from '../utils/dates.js';
import * as investmentService from '../services/investment.service.js';
import * as installmentService from '../services/installment.service.js';
import * as investorService from '../services/investor.service.js';
import { toPoisha } from '../utils/money.js';
import { config } from '../config/index.js';

/** Accepts either poisha (integer, preferred) or taka (string/number decimal). */
export function readAmount(body, field = 'totalAmount') {
  if (body[`${field}Poisha`] !== undefined) return Number(body[`${field}Poisha`]);
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s৳]/g, ''));
  if (!Number.isFinite(n)) return Number.NaN;
  // Values with decimals are taka; integers are treated as taka too (>= 1 BDT).
  return toPoisha(n);
}

function parseScheduleInput(req, { requireSchedule = false } = {}) {
  const body = req.body ?? {};
  const v = new Validator(body);
  const totalAmount = readAmount(body, 'totalAmount');
  if (totalAmount === undefined && requireSchedule) v.fail('totalAmount', 'Total amount is required');
  else if (totalAmount !== undefined && !isPositiveInt(totalAmount)) v.fail('totalAmount', 'Enter a valid amount greater than zero');
  else if (totalAmount !== undefined) v.values.totalAmount = totalAmount;

  v.int('installmentCount', { required: requireSchedule, min: 1, max: 120, label: 'Number of installments' });
  v.date('firstDueDate', { required: requireSchedule, label: 'First due date' });
  v.oneOf('interval', ['MONTHLY', 'WEEKLY'], { required: false, label: 'Interval' });
  v.string('title', { required: false, max: 160, label: 'Title' });
  v.string('notes', { required: false, max: LIMITS.notes, label: 'Notes' });
  const input = v.result();
  return input;
}

export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const result = await investmentService.listInvestments({
    search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    investorId: req.query.investorId ? Number(req.query.investorId) : undefined,
    hasOverdue: String(req.query.hasOverdue) === 'true',
    sort: req.query.sort,
    dir: req.query.dir,
    limit,
    offset,
  });
  return ok(res, { ...paged({ rows: result.rows, total: result.total, limit, offset }), totals: result.totals });
}

export async function detail(req, res) {
  const data = await investmentService.getInvestmentDetail(Number(req.params.id));
  const today = dhakaDate();
  return ok(res, {
    ...data,
    installments: data.installments.map((row) => ({ ...row, effective_status: installmentService.deriveStatus(row, today) })),
  });
}

export async function create(req, res) {
  const schedule = parseScheduleInput(req, { requireSchedule: true });
  const investorId = Number(req.body?.investorId);
  if (!Number.isInteger(investorId) || investorId <= 0) throw badRequest('A valid investor is required');
  const result = await investmentService.createInvestment({ investorId, ...schedule }, req.admin, req);
  return created(res, {
    investment: { ...result.investment, installments: result.installments.map(({ pay_token, ...rest }) => rest) },
    // The raw tokens are returned once so the UI can copy/send them immediately.
    links: result.installments.map((row) => ({ installmentId: row.id, serial: row.serial, url: `${config.publicBaseUrl}/pay/${row.pay_token}` })),
    schedule: result.plan,
  });
}

export async function updateTotal(req, res) {
  const body = req.body ?? {};
  const totalAmount = readAmount(body, 'totalAmount');
  if (!isPositiveInt(totalAmount)) throw badRequest('Enter a valid total amount');
  const v = new Validator(body);
  v.string('reason', { required: false, max: LIMITS.reason, label: 'Reason' });
  v.oneOf('strategy', ['REDISTRIBUTE', 'SCALE'], { required: false, label: 'Strategy' });
  const { reason, strategy } = v.result();
  const investment = await investmentService.changeInvestmentTotal(
    Number(req.params.id),
    { totalAmount, reason, strategy: strategy ?? 'REDISTRIBUTE' },
    req.admin,
    req,
  );
  return ok(res, { investment });
}

export async function setStatus(req, res) {
  const v = new Validator(req.body);
  v.oneOf('status', investmentService.INVESTMENT_STATUSES, { required: true, label: 'Status' });
  v.string('reason', { required: false, max: LIMITS.reason, label: 'Reason' });
  const { status, reason } = v.result();
  const investment = await investmentService.setInvestmentStatus(Number(req.params.id), status, { reason }, req.admin, req);
  return ok(res, { investment });
}

/** GET /investments/schedule-preview?totalAmount=...&installmentCount=... */
export async function schedulePreview(req, res) {
  const schedule = parseScheduleInput(req, { requireSchedule: true });
  const preview = await investmentService.schedulePreview(schedule);
  return ok(res, preview);
}

export async function resync(req, res) {
  const rows = await investmentService.resyncSchedule(Number(req.params.id), req.admin);
  return ok(res, { installments: rows });
}

/** Installment surface scoped to an investment (used by the detail page). */
export async function listInstallments(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
  const result = await installmentService.listInstallments({
    investmentId: Number(req.params.id),
    status: req.query.status,
    sort: req.query.sort ?? 'serial',
    dir: req.query.dir ?? 'asc',
    limit,
    offset,
  });
  const today = dhakaDate();
  return ok(res, paged({ rows: result.rows.map((r) => ({ ...r, effective_status: installmentService.deriveStatus(r, today) })), total: result.total, limit, offset }));
}

export { investorService };
