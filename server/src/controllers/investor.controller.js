import { Validator, LIMITS } from '../utils/validate.js';
import { ok, created, binary } from '../utils/http.js';
import { badRequest, notFound } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { dhakaDate } from '../utils/dates.js';
import * as investorService from '../services/investor.service.js';
import { deriveStatus } from '../services/installment.service.js';
import { query } from '../db/client.js';
import { NOW } from '../db/sql.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
export function validateNominees(v, field = 'nominees') {
  return v.array(
    field,
    (item, index, sub) => {
      sub.string('name', { required: true, max: LIMITS.name, label: 'Nominee name' });
      sub.string('relation', { required: true, max: 60, label: 'Relation' });
      sub.mobile('mobile', { required: true, label: 'Nominee mobile' });
      sub.nid('nid', { required: false, label: 'Nominee NID' });
      const share = sub.raw('share_percent');
      const num = typeof share === 'number' ? share : Number(String(share ?? '').trim());
      if (!Number.isFinite(num) || num <= 0 || num > 100) sub.fail('share_percent', 'Share must be between 0 and 100');
      else sub.values.share_percent = Math.round(num * 100) / 100;
      return {
        name: sub.values.name,
        relation: sub.values.relation,
        mobile: sub.values.mobile,
        nid: sub.values.nid ?? null,
        share_percent: sub.values.share_percent,
      };
    },
    { required: false, max: 3, label: 'Nominees' },
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
export async function list(req, res) {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const filters = {
    search: req.query.search ? String(req.query.search).slice(0, 80) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    hasNominees: req.query.hasNominees === undefined ? undefined : String(req.query.hasNominees) === 'true',
    includeDeleted: String(req.query.includeDeleted) === 'true',
    sort: req.query.sort,
    dir: req.query.dir,
    limit,
    offset,
  };
  if (filters.status && !investorService.INVESTOR_STATUSES.includes(filters.status)) throw badRequest('Invalid status filter');
  const result = await investorService.listInvestors(filters);
  return ok(
    res,
    paged({ rows: result.rows.map((row) => investorService.presentInvestor(row, req.admin.role)), total: result.total, limit, offset }),
  );
}

export async function detail(req, res) {
  const id = Number(req.params.id);
  const investor = await investorService.getInvestorDetail(id);

  const investments = await query(
    `select v.id, v.title, v.total_amount, v.installment_count, v.status, v.interval, v.created_at,
            coalesce(sum(inst.amount_paid),0) as collected,
            coalesce(sum(case when inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE') then inst.amount - inst.amount_paid else 0 end),0) as outstanding,
            min(case when inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE') then inst.due_date end) as next_due_date
       from investments v
       left join installments inst on inst.investment_id = v.id
      where v.investor_id = ?1
      group by v.id order by v.created_at desc`,
    [id],
  );

  const installments = await query(
    `select inst.*, v.id as investment_id, max(inst.amount - inst.amount_paid, 0) as outstanding,
            (inst.pay_token_hash is not null and inst.token_expires_at > ${NOW}) as pay_link_active
       from installments inst join investments v on v.id = inst.investment_id
      where v.investor_id = ?1 order by v.id desc, inst.serial asc`,
    [id],
  );

  const payments = await query(
    `select p.id, p.amount, p.status, p.method, p.gateway, p.trx_id, p.manual_reference, p.paid_at, p.created_at,
            inst.serial as installment_serial, v.id as investment_id
       from payments p
       join installments inst on inst.id = p.installment_id
       join investments v on v.id = inst.investment_id
      where v.investor_id = ?1 order by p.created_at desc limit 100`,
    [id],
  );

  const today = dhakaDate();
  return ok(res, {
    investor: investorService.presentInvestor(investor, req.admin.role),
    nominees: investorService.presentNominees(investor.nominees, req.admin.role),
    investments: investments.rows,
    installments: installments.rows.map((row) => ({ ...row, effective_status: deriveStatus(row, today) })),
    payments: payments.rows,
  });
}

export async function create(req, res) {
  const v = new Validator(req.body);
  v.string('name', { required: true, max: LIMITS.name, label: 'Investor name' });
  v.mobile('mobile', { required: true });
  v.nid('nid', { required: false });
  v.string('address', { required: false, max: LIMITS.address, label: 'Address' });
  v.string('notes', { required: false, max: LIMITS.notes, label: 'Notes' });
  v.oneOf('status', investorService.INVESTOR_STATUSES, { required: false, label: 'Status' });
  validateNominees(v);
  const input = v.result();

  // Nominee changes are SUPER_ADMIN only (see docs/permissions.md).
  if (input.nominees?.length && req.admin.role !== 'SUPER_ADMIN') {
    throw badRequest('Only a Super Admin can add nominees');
  }

  const investor = await investorService.createInvestor(input, req.admin, req);
  return created(res, {
    investor: investorService.presentInvestor(investor, req.admin.role),
    nominees: investorService.presentNominees(investor.nominees ?? [], req.admin.role),
  });
}

export async function update(req, res) {
  const id = Number(req.params.id);
  const v = new Validator(req.body);
  v.string('name', { required: false, max: LIMITS.name, label: 'Investor name' });
  v.mobile('mobile', { required: false });
  v.string('address', { required: false, max: LIMITS.address, label: 'Address' });
  v.string('notes', { required: false, max: LIMITS.notes, label: 'Notes' });
  v.oneOf('status', investorService.INVESTOR_STATUSES, { required: false, label: 'Status' });
  // NID edits are sensitive: SUPER_ADMIN only.
  if (req.body?.nid !== undefined) {
    if (req.admin.role !== 'SUPER_ADMIN') throw badRequest('Only a Super Admin can change an NID');
    if (req.body.nid === null || req.body.nid === '') v.values.nid = null;
    else v.nid('nid', { required: true });
  }
  const changes = v.result();
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update');
  const investor = await investorService.updateInvestor(id, changes, req.admin, req);
  return ok(res, {
    investor: investorService.presentInvestor(investor, req.admin.role),
    nominees: investorService.presentNominees(investor.nominees ?? [], req.admin.role),
  });
}

export async function setStatus(req, res) {
  const v = new Validator(req.body);
  v.oneOf('status', investorService.INVESTOR_STATUSES, { required: true, label: 'Status' });
  v.string('reason', { required: false, max: LIMITS.reason, label: 'Reason' });
  const { status, reason } = v.result();
  const investor = await investorService.setInvestorStatus(Number(req.params.id), status, { reason }, req.admin, req);
  return ok(res, { investor: investorService.presentInvestor(investor, req.admin.role) });
}

export async function remove(req, res) {
  const v = new Validator(req.body);
  v.string('reason', { required: false, max: LIMITS.reason, label: 'Reason' });
  const { reason } = v.result();
  const investor = await investorService.softDeleteInvestor(Number(req.params.id), { reason }, req.admin, req);
  return ok(res, { investor: investorService.presentInvestor(investor, req.admin.role) });
}

export async function restore(req, res) {
  const investor = await investorService.restoreInvestor(Number(req.params.id), req.admin, req);
  return ok(res, { investor: investorService.presentInvestor(investor, req.admin.role) });
}

/** POST /investors/:id/nominees - replaces the whole set (SUPER_ADMIN only). */
export async function replaceNominees(req, res) {
  const v = new Validator(req.body);
  const nominees = validateNominees(v) ?? [];
  v.result();
  const saved = await investorService.replaceNominees(Number(req.params.id), nominees, req.admin, req);
  return ok(res, { nominees: investorService.presentNominees(saved, req.admin.role) });
}

export async function updateNominee(req, res) {
  const v = new Validator(req.body);
  v.string('name', { required: false, max: LIMITS.name, label: 'Nominee name' });
  v.string('relation', { required: false, max: 60, label: 'Relation' });
  v.mobile('mobile', { required: false, label: 'Nominee mobile' });
  v.nid('nid', { required: false, label: 'Nominee NID' });
  const share = req.body?.share_percent;
  if (share !== undefined) {
    const num = Number(share);
    if (!Number.isFinite(num) || num <= 0 || num > 100) throw badRequest('Share must be between 0 and 100');
    v.values.share_percent = Math.round(num * 100) / 100;
  }
  const changes = v.result();
  const nominee = await investorService.updateNominee(Number(req.params.id), Number(req.params.nomineeId), changes, req.admin, req);
  return ok(res, { nominee: investorService.presentNominees([nominee], req.admin.role)[0] });
}

export async function revealNid(req, res) {
  const data = await investorService.revealNid(Number(req.params.id), req.admin, req);
  return ok(res, data);
}

export async function revealNomineeNid(req, res) {
  const data = await investorService.revealNomineeNid(Number(req.params.id), Number(req.params.nomineeId), req.admin, req);
  return ok(res, data);
}

export async function uploadPhoto(req, res) {
  const result = await investorService.setPhoto(Number(req.params.id), req.body, req.admin, req);
  return ok(res, result);
}

export async function getPhoto(req, res) {
  const file = await investorService.getPhoto(Number(req.params.id));
  return binary(res, file.buffer, { mime: file.mime, cache: 'private, max-age=300' });
}

export async function uploadNidScan(req, res) {
  const result = await investorService.setNidScan(Number(req.params.id), req.body, req.admin, req);
  return ok(res, result);
}

export async function getNidScan(req, res) {
  const file = await investorService.getNidScan(Number(req.params.id), req.admin, req);
  return binary(res, file.buffer, { mime: file.mime });
}

export function notFoundInvestor() {
  throw notFound('Investor not found');
}
