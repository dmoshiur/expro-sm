import { Validator, LIMITS } from '../utils/validate.js';
import { ok, created, binary } from '../utils/http.js';
import { badRequest, notFound, forbidden, unprocessable } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { dhakaDate } from '../utils/dates.js';
import * as investorService from '../services/investor.service.js';
import * as investorAuth from '../services/investor-auth.service.js';
import * as walletService from '../services/wallet.service.js';
import * as documentService from '../services/document.service.js';
import * as alertsService from '../services/alerts.service.js';
import { toPoisha } from '../utils/money.js';
import { INVESTOR_PASSWORD_MIN_LENGTH } from '../services/crypto.service.js';
import { deriveStatus, INSTALLMENT_STATUSES } from '../services/installment.service.js';
import { maskMobile } from '../utils/mask.js';
import { config } from '../config/index.js';
import { query } from '../db/client.js';
import { NOW } from '../db/sql.js';

export const INSTALLMENT_STATUS_FILTERS = INSTALLMENT_STATUSES;

/** Optional profile fields (migration 002), shared by admin + portal forms. */
export function applyProfileValidators(v) {
  v.string('name_bangla', { required: false, max: LIMITS.name, label: 'Name (Bangla)' });
  v.email('email', { required: false });
  v.mobile('alternate_mobile', { required: false, label: 'Alternate mobile' });
  v.date('date_of_birth', { required: false, label: 'Date of birth' });
  const dob = v.values.date_of_birth;
  if (dob) {
    if (dob > dhakaDate()) v.fail('date_of_birth', 'Date of birth cannot be in the future');
    else if (dob < '1900-01-01') v.fail('date_of_birth', 'Date of birth looks too far in the past');
  }
  v.oneOf('gender', investorService.GENDERS, { required: false, label: 'Gender' });
  v.string('father_name', { required: false, max: LIMITS.name, label: 'Father / husband name' });
  v.string('mother_name', { required: false, max: LIMITS.name, label: "Mother's name" });
  v.string('religion', { required: false, max: 60, label: 'Religion' });
  v.string('education', { required: false, max: 120, label: 'Education' });
  v.string('present_address', { required: false, max: LIMITS.address, label: 'Present address' });
  v.string('permanent_address', { required: false, max: LIMITS.address, label: 'Permanent address' });
  return v;
}

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
        // An existing nominee keeps its row id so NIDs and photos survive a save.
        id: Number.isInteger(Number(item?.id)) && Number(item.id) > 0 ? Number(item.id) : null,
        name: sub.values.name,
        relation: sub.values.relation,
        mobile: sub.values.mobile,
        nid: sub.values.nid,
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
  const [documents, wallet, alerts, portalAccess] = await Promise.all([
    documentService.listDocuments(id),
    walletService.getWallet(id),
    alertsService.getInvestorAlerts(id),
    investorAuth.getPortalAccess(id).catch(() => null),
  ]);
  return ok(res, {
    investor: investorService.presentInvestor(investor, req.admin.role),
    nominees: investorService.presentNominees(investor.nominees, req.admin.role),
    investments: investments.rows.map((row) => ({
      ...row,
      progress_percent:
        Number(row.total_amount) > 0 ? Math.min(100, Math.round((Number(row.collected) / Number(row.total_amount)) * 100)) : 0,
    })),
    installments: installments.rows.map((row) => ({ ...row, effective_status: deriveStatus(row, today) })),
    payments: payments.rows,
    documents,
    wallet,
    alerts,
    portal: portalAccess ? { ...portalAccess, login_url: `${config.publicBaseUrl}/portal/login` } : null,
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
  applyProfileValidators(v);
  validateNominees(v);
  const input = v.result();

  // Optional portal access for the new investor: { enabled, password?, sendSms? }.
  let portal = null;
  if (req.body?.portal !== undefined && req.body?.portal !== null) {
    const pv = new Validator(req.body.portal);
    pv.bool('enabled', { label: 'Enable portal login' });
    pv.string('password', { required: false, min: INVESTOR_PASSWORD_MIN_LENGTH, max: LIMITS.password.max, label: 'Temporary portal password' });
    pv.bool('sendSms', { label: 'Send credentials by SMS' });
    portal = pv.result();
  }

  // Nominee changes are SUPER_ADMIN only (see docs/permissions.md).
  if (input.nominees?.length && req.admin.role !== 'SUPER_ADMIN') {
    throw badRequest('Only a Super Admin can add nominees');
  }

  const investor = await investorService.createInvestor({ ...input, portal }, req.admin, req);
  const { portal: portalResult, nominees: createdNominees, ...investorRow } = investor;

  let sms = null;
  if (portalResult?.enabled && portalResult.tempPassword && portal?.sendSms) {
    try {
      const sent = await investorAuth.sendPortalCredentialsSms({
        investor: investorRow,
        tempPassword: portalResult.tempPassword,
        actor: req.admin,
        req,
      });
      sms = { sent: sent.ok, status: sent.status };
    } catch {
      sms = { sent: false, status: 'FAILED' };
    }
  }

  return created(res, {
    investor: investorService.presentInvestor(investorRow, req.admin.role),
    nominees: investorService.presentNominees(createdNominees ?? [], req.admin.role),
    portal: {
      enabled: Boolean(portalResult?.enabled),
      // Returned exactly once so the admin can hand it to the investor.
      tempPassword: portalResult?.tempPassword ?? null,
      member_code: investorRow.member_code,
      login_url: `${config.publicBaseUrl}/portal/login`,
      sms,
    },
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
  applyProfileValidators(v);
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

// ---------------------------------------------------------------------------
// Portal access management (admin side of investor self-service login)
// ---------------------------------------------------------------------------
/** GET /investors/:id/portal-access */
export async function portalAccess(req, res) {
  const portal = await investorAuth.getPortalAccess(Number(req.params.id));
  if (req.admin.role === 'VIEWER') portal.mobile = maskMobile(portal.mobile);
  return ok(res, { portal });
}

/** POST /investors/:id/portal-access/password { password?, sendSms? } */
export async function setPortalPassword(req, res) {
  const v = new Validator(req.body);
  v.string('password', { required: false, min: INVESTOR_PASSWORD_MIN_LENGTH, max: LIMITS.password.max, label: 'Temporary password' });
  v.bool('sendSms', { label: 'Send credentials by SMS' });
  const input = v.result();

  const id = Number(req.params.id);
  const result = await investorAuth.setPortalPasswordByAdmin(id, { password: input.password ?? null }, req.admin, req);

  let sms = null;
  if (input.sendSms) {
    try {
      const investor = await investorService.getInvestor(id);
      const sent = await investorAuth.sendPortalCredentialsSms({
        investor,
        tempPassword: result.tempPassword,
        actor: req.admin,
        req,
      });
      sms = { sent: sent.ok, status: sent.status };
    } catch {
      sms = { sent: false, status: 'FAILED' };
    }
  }
  return ok(res, { tempPassword: result.tempPassword, generated: result.generated, portal: result.portal, sms });
}

/** POST /investors/:id/portal-access/enabled { enabled } */
export async function setPortalEnabled(req, res) {
  const v = new Validator(req.body);
  v.bool('enabled', { required: true, label: 'Enabled' });
  const { enabled } = v.result();
  const portal = await investorAuth.setPortalEnabled(Number(req.params.id), enabled, req.admin, req);
  return ok(res, { portal });
}

/** POST /investors/:id/portal-access/revoke-sessions */
export async function revokePortalSessions(req, res) {
  const portal = await investorAuth.revokePortalSessionsByAdmin(Number(req.params.id), req.admin, req);
  return ok(res, { portal });
}

// ---------------------------------------------------------------------------
// Wallet (staff side): ledger, manual entries and request decisions
// ---------------------------------------------------------------------------
/** Taka input (string/number) -> integer poisha, with a field-level 422. */
export function parseTakaAmount(value, field = 'amount') {
  const poisha = toPoisha(value);
  if (!Number.isSafeInteger(poisha) || poisha <= 0) {
    throw unprocessable('Enter a valid amount greater than zero', { [field]: 'Enter a valid amount greater than zero' });
  }
  return poisha;
}

/** GET /investors/:id/wallet */
export async function wallet(req, res) {
  return ok(res, await walletService.getWallet(Number(req.params.id)));
}

/** POST /investors/:id/wallet/transactions - manual ledger entry (COMPLETED). */
export async function recordWalletEntry(req, res) {
  const v = new Validator(req.body);
  v.oneOf('type', walletService.WALLET_TYPES, { required: true, label: 'Type' });
  v.oneOf('direction', ['CREDIT', 'DEBIT'], { required: false, label: 'Direction' });
  v.oneOf('method', walletService.WALLET_METHODS, { required: false, label: 'Method' });
  v.string('externalReference', { required: false, max: 120, label: 'Reference' });
  v.string('note', { required: false, max: 500, label: 'Note' });
  const input = v.result();
  const amount = parseTakaAmount(req.body?.amount);
  const result = await walletService.recordLedgerEntry(
    Number(req.params.id),
    { ...input, amount },
    req.admin,
    req,
  );
  return created(res, result);
}

/** POST /investors/:id/wallet/transactions/:txId/decide { decision, note } */
export async function decideWalletTransaction(req, res) {
  const v = new Validator(req.body);
  v.oneOf('decision', ['APPROVE', 'REJECT'], { required: true, label: 'Decision' });
  v.string('note', { required: false, max: 500, label: 'Note' });
  const input = v.result();
  const result = await walletService.decideTransaction(
    Number(req.params.id),
    Number(req.params.txId),
    input,
    req.admin,
    req,
  );
  return ok(res, result);
}

// ---------------------------------------------------------------------------
// Documents: upload, file read and Super Admin verification
// ---------------------------------------------------------------------------
/** Kinds whose bytes are NID / signature material: Super Admin only. */
const SUPER_ADMIN_DOCUMENTS = ['NID_FRONT', 'NID_BACK', 'SIGNATURE'];

function assertCanUseDocument(admin, kind, { write = false } = {}) {
  if (kind === 'PHOTO' || kind === 'NOMINEE_PHOTO') {
    if (write && admin.role === 'VIEWER') throw forbidden('Viewers cannot upload documents');
    return;
  }
  if (admin.role !== 'SUPER_ADMIN') {
    throw forbidden('Only a Super Admin can access NID and signature documents');
  }
}

/** GET /investors/:id/documents */
export async function listDocuments(req, res) {
  return ok(res, await documentService.listDocuments(Number(req.params.id)));
}

/** POST /investors/:id/documents/:kind  (raw image/pdf body) */
export async function uploadDocument(req, res) {
  const kind = String(req.params.kind ?? '').toUpperCase();
  assertCanUseDocument(req.admin, kind, { write: true });
  const result = await documentService.uploadDocument(Number(req.params.id), kind, req.body, {
    actor: req.admin,
    req,
    nomineeId: req.params.nomineeId ? Number(req.params.nomineeId) : null,
  });
  return ok(res, {
    document: result,
    documents: await documentService.listDocuments(Number(req.params.id)),
  });
}

/** GET /investors/:id/documents/:kind/file */
export async function documentFile(req, res) {
  const kind = String(req.params.kind ?? '').toUpperCase();
  assertCanUseDocument(req.admin, kind);
  const file = await documentService.getDocumentFile(Number(req.params.id), kind, {
    actor: req.admin,
    req,
    nomineeId: req.params.nomineeId ? Number(req.params.nomineeId) : null,
  });
  return binary(res, file.buffer, { mime: file.mime, cache: 'private, max-age=60' });
}

/** POST /investors/:id/documents/:kind/review { status, note } */
export async function reviewDocument(req, res) {
  const kind = String(req.params.kind ?? '').toUpperCase();
  const v = new Validator(req.body);
  v.oneOf('status', documentService.REVIEW_STATUSES, { required: true, label: 'Review status' });
  v.string('note', { required: false, max: 500, label: 'Note' });
  const input = v.result();
  const document = await documentService.reviewDocument(Number(req.params.id), kind, input, req.admin, req, {
    nomineeId: req.params.nomineeId ? Number(req.params.nomineeId) : null,
  });
  return ok(res, { document, documents: await documentService.listDocuments(Number(req.params.id)) });
}

/** Nominee photo upload / read / review (thin wrappers around the document API). */
export async function uploadNomineePhoto(req, res) {
  req.params.kind = 'NOMINEE_PHOTO';
  return uploadDocument(req, res);
}

export async function nomineePhotoFile(req, res) {
  req.params.kind = 'NOMINEE_PHOTO';
  return documentFile(req, res);
}

export async function reviewNomineePhoto(req, res) {
  req.params.kind = 'NOMINEE_PHOTO';
  return reviewDocument(req, res);
}

// ---------------------------------------------------------------------------
// Membership approval + account freeze (Super Admin controls)
// ---------------------------------------------------------------------------
/** POST /investors/:id/membership { status, note } */
export async function decideMembership(req, res) {
  const v = new Validator(req.body);
  v.oneOf('status', ['APPROVED', 'REJECTED'], { required: true, label: 'Membership status' });
  v.string('note', { required: false, max: 500, label: 'Note' });
  const input = v.result();
  const investor = await investorService.decideMembership(Number(req.params.id), input, req.admin, req);
  return ok(res, { investor: investorService.presentInvestor(investor, req.admin.role) });
}

/** POST /investors/:id/freeze { frozen, reason } */
export async function setFrozen(req, res) {
  const v = new Validator(req.body);
  v.bool('frozen', { required: true, label: 'Frozen' });
  v.string('reason', { required: false, max: 500, label: 'Reason' });
  const input = v.result();
  if (input.frozen && !input.reason) {
    throw unprocessable('Explain why the account is being frozen', { reason: 'Explain why the account is being frozen' });
  }
  const { frozen, reason } = input;
  const investor = await investorService.setFrozen(Number(req.params.id), { frozen, reason }, req.admin, req);
  return ok(res, { investor: investorService.presentInvestor(investor, req.admin.role) });
}

export function notFoundInvestor() {
  throw notFound('Investor not found');
}
