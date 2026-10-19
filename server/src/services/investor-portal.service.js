/**
 * Investor portal read models + self-service writes.
 *
 * Every function here is scoped by `investorId` taken from the portal
 * session (never from the request), so an investor can only ever see or
 * touch their own investments, installments, payments and documents.
 * Identity fields (name, mobile, NID, status, member code) stay admin-managed;
 * the investor completes the rest of the profile themselves.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { badRequest, notFound } from '../utils/errors.js';
import { dhakaDate } from '../utils/dates.js';
import { deriveStatus } from './installment.service.js';
import { issueToken, buildPayUrl } from './paylink.service.js';
import { PROFILE_FIELDS } from './investor.service.js';
import { memberCodeForId } from './investor-auth.service.js';
import * as audit from './audit.service.js';

const OPEN = `('PENDING','PARTIALLY_PAID','OVERDUE')`;

// Profile completeness checklist: what a "proper" member profile contains.
const COMPLETION_CHECKS = [
  ['photo', 'Profile photo', (i) => Boolean(i.has_photo)],
  ['email', 'Email address', (i) => Boolean(i.email)],
  ['alternate_mobile', 'Alternate mobile', (i) => Boolean(i.alternate_mobile)],
  ['date_of_birth', 'Date of birth', (i) => Boolean(i.date_of_birth)],
  ['gender', 'Gender', (i) => Boolean(i.gender)],
  ['father_name', 'Father / husband name', (i) => Boolean(i.father_name)],
  ['mother_name', "Mother's name", (i) => Boolean(i.mother_name)],
  ['present_address', 'Present address', (i) => Boolean(i.present_address || i.address)],
  ['permanent_address', 'Permanent address', (i) => Boolean(i.permanent_address)],
  ['nid', 'NID number (ask the office)', (i) => Boolean(i.nid_last4)],
  ['nid_scan', 'NID scan', (i) => Boolean(i.has_nid_scan)],
  ['nominees', 'Nominee (ask the office)', (i) => (i.nominees?.length ?? 0) > 0],
];

export function profileCompletion(investor) {
  const missing = COMPLETION_CHECKS.filter(([, , ok]) => !ok(investor)).map(([key, label]) => ({ key, label }));
  const done = COMPLETION_CHECKS.length - missing.length;
  return {
    percent: Math.round((done / COMPLETION_CHECKS.length) * 100),
    done,
    total: COMPLETION_CHECKS.length,
    missing,
  };
}

/** Own profile DTO - never includes admin notes, creators or credentials. */
export function ownProfileShape(row, nominees = []) {
  return {
    id: row.id,
    member_code: row.member_code ?? memberCodeForId(row.id),
    name: row.name,
    mobile: row.mobile,
    alternate_mobile: row.alternate_mobile ?? null,
    email: row.email ?? null,
    date_of_birth: row.date_of_birth ?? null,
    gender: row.gender ?? null,
    father_name: row.father_name ?? null,
    mother_name: row.mother_name ?? null,
    religion: row.religion ?? null,
    education: row.education ?? null,
    address: row.address ?? null,
    present_address: row.present_address ?? row.address ?? null,
    permanent_address: row.permanent_address ?? null,
    nid_last4: row.nid_last4 ?? null,
    has_nid: Boolean(row.nid_last4),
    has_photo: Boolean(row.has_photo),
    has_nid_scan: Boolean(row.has_nid_scan),
    status: row.status,
    member_since: row.created_at,
    last_login_at: row.last_login_at ?? null,
    password_changed_at: row.password_changed_at ?? null,
    must_change_password: Boolean(row.must_change_password),
    nominees: nominees.map((n) => ({
      id: n.id,
      name: n.name,
      relation: n.relation,
      mobile: n.mobile,
      nid_last4: n.nid_last4 ?? null,
      share_percent: n.share_percent,
    })),
  };
}

async function loadOwnRow(investorId, client = undefined) {
  const res = await query(
    `select i.*, (i.photo is not null) as has_photo, (i.nid_scan is not null) as has_nid_scan
       from investors i where i.id = ?1 and i.deleted_at is null`,
    [investorId],
    client,
  );
  if (!res.rows[0]) throw notFound('Investor not found');
  return res.rows[0];
}

export async function getOwnProfile(investorId) {
  const row = await loadOwnRow(investorId);
  const nominees = await query(
    'select id, name, relation, mobile, nid_last4, share_percent from nominees where investor_id = ?1 order by share_percent desc, id asc',
    [investorId],
  );
  const profile = ownProfileShape(row, nominees.rows);
  return { profile, completion: profileCompletion(profile) };
}

/**
 * Self-service profile update. Only PROFILE_FIELDS may change; name/mobile/
 * NID/status are identity data managed by the office.
 */
export async function updateOwnProfile(investorId, changes, req) {
  return withTransaction(async (client) => {
    const before = await loadOwnRow(investorId, client);
    const sets = [];
    const params = [investorId];
    const push = (v) => {
      params.push(v);
      return `?${params.length}`;
    };
    const changedFields = [];
    for (const field of PROFILE_FIELDS) {
      if (changes[field] !== undefined && changes[field] !== (before[field] ?? undefined)) {
        sets.push(`${field} = ${push(changes[field])}`);
        changedFields.push(field);
      }
    }
    if (sets.length === 0) return getProfileWithClient(investorId, client);
    sets.push(`updated_at = ${NOW}`);
    await query(`update investors set ${sets.join(', ')} where id = ?1`, params, client);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTOR_PROFILE_UPDATED,
        entity: 'investor',
        entityId: investorId,
        oldValue: pickProfile(before),
        newValue: pickProfile({ ...before, ...changes }),
        meta: { self: true, investorId, fields: changedFields },
        req,
      },
      client,
    );
    return getProfileWithClient(investorId, client);
  });
}

async function getProfileWithClient(investorId, client) {
  const row = await loadOwnRow(investorId, client);
  const nominees = await query(
    'select id, name, relation, mobile, nid_last4, share_percent from nominees where investor_id = ?1 order by share_percent desc, id asc',
    [investorId],
    client,
  );
  const profile = ownProfileShape(row, nominees.rows);
  return { profile, completion: profileCompletion(profile) };
}

function pickProfile(row) {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f, row[f] ?? null]));
}

// ---------------------------------------------------------------------------
// Dashboard / money views
// ---------------------------------------------------------------------------
export async function getDashboard(investorId) {
  const today = dhakaDate();
  const { profile, completion } = await getOwnProfile(investorId);

  const totalsRes = await query(
    `select
       coalesce(sum(case when v.status <> 'CANCELLED' then v.total_amount else 0 end), 0) as total_invested,
       count(distinct case when v.status = 'ACTIVE' then v.id end) as active_investments,
       count(distinct case when v.status = 'COMPLETED' then v.id end) as completed_investments
     from investments v where v.investor_id = ?1`,
    [investorId],
  );
  const instRes = await query(
    `select
       coalesce(sum(inst.amount_paid), 0) as total_paid,
       coalesce(sum(case when inst.status in ${OPEN} then inst.amount - inst.amount_paid else 0 end), 0) as total_remaining,
       coalesce(sum(case when inst.status in ${OPEN} and inst.due_date <= ?2 then inst.amount - inst.amount_paid else 0 end), 0) as due_now,
       coalesce(sum(case when inst.status in ${OPEN} and inst.due_date < ?2 then inst.amount - inst.amount_paid else 0 end), 0) as overdue_amount,
       coalesce(sum(case when inst.status in ${OPEN} and inst.due_date < ?2 then 1 else 0 end), 0) as overdue_count,
       coalesce(sum(case when inst.status = 'PAID' then 1 else 0 end), 0) as paid_installments,
       count(*) as total_installments
     from installments inst
     join investments v on v.id = inst.investment_id
     where v.investor_id = ?1 and v.status <> 'CANCELLED' and inst.status <> 'CANCELLED'`,
    [investorId, today],
  );

  const upcoming = await listOwnInstallments(investorId, { openOnly: true, limit: 5 });
  const recentPayments = await listOwnPayments(investorId, { limit: 5, status: 'SUCCESS' });

  const totals = totalsRes.rows[0];
  const inst = instRes.rows[0];
  return {
    profile,
    completion,
    summary: {
      total_invested: Number(totals.total_invested),
      total_paid: Number(inst.total_paid),
      total_remaining: Number(inst.total_remaining),
      due_now: Number(inst.due_now),
      overdue_amount: Number(inst.overdue_amount),
      overdue_count: Number(inst.overdue_count),
      active_investments: Number(totals.active_investments),
      completed_investments: Number(totals.completed_investments),
      paid_installments: Number(inst.paid_installments),
      total_installments: Number(inst.total_installments),
      next_due: upcoming[0]
        ? {
            installment_id: upcoming[0].id,
            serial: upcoming[0].serial,
            investment_id: upcoming[0].investment_id,
            investment_title: upcoming[0].investment_title,
            amount: upcoming[0].outstanding,
            due_date: upcoming[0].due_date,
            status: upcoming[0].effective_status,
          }
        : null,
    },
    upcoming_installments: upcoming,
    recent_payments: recentPayments,
  };
}

export async function listOwnInvestments(investorId) {
  const today = dhakaDate();
  const res = await query(
    `select v.id, v.title, v.total_amount, v.installment_count, v.interval, v.first_due_date, v.status, v.created_at,
            coalesce(sum(inst.amount_paid), 0) as collected,
            coalesce(sum(case when inst.status in ${OPEN} then inst.amount - inst.amount_paid else 0 end), 0) as outstanding,
            coalesce(sum(case when inst.status = 'PAID' then 1 else 0 end), 0) as paid_installments,
            count(inst.id) as installment_rows,
            min(case when inst.status in ${OPEN} then inst.due_date end) as next_due_date,
            coalesce(sum(case when inst.status in ${OPEN} and inst.due_date < ?2 then 1 else 0 end), 0) as overdue_installments
       from investments v
       left join installments inst on inst.investment_id = v.id
      where v.investor_id = ?1
      group by v.id order by v.created_at desc`,
    [investorId, today],
  );
  return res.rows.map((row) => ({
    ...row,
    progress_percent:
      Number(row.total_amount) > 0 ? Math.min(100, Math.round((Number(row.collected) / Number(row.total_amount)) * 100)) : 0,
  }));
}

export async function listOwnInstallments(investorId, { status = null, openOnly = false, limit = 200 } = {}) {
  const today = dhakaDate();
  const res = await query(
    `select inst.id, inst.investment_id, v.title as investment_title, inst.serial, inst.amount, inst.amount_paid,
            max(inst.amount - inst.amount_paid, 0) as outstanding, inst.due_date, inst.status, inst.paid_at
       from installments inst
       join investments v on v.id = inst.investment_id
      where v.investor_id = ?1
      order by inst.due_date asc, inst.serial asc
      limit ?2`,
    [investorId, Math.min(Number(limit) || 200, 500)],
  );
  let rows = res.rows.map((row) => ({ ...row, effective_status: deriveStatus(row, today) }));
  if (openOnly) rows = rows.filter((r) => ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(r.effective_status));
  if (status) rows = rows.filter((r) => r.effective_status === status);
  return rows;
}

export async function listOwnPayments(investorId, { status = null, limit = 100 } = {}) {
  const params = [investorId];
  let statusSql = '';
  if (status) {
    params.push(status);
    statusSql = `and p.status = ?${params.length}`;
  }
  params.push(Math.min(Number(limit) || 100, 200));
  const res = await query(
    `select p.id, p.amount, p.status, p.method, p.gateway, p.trx_id, p.manual_reference, p.paid_at, p.created_at,
            inst.serial as installment_serial, inst.id as installment_id, v.id as investment_id, v.title as investment_title
       from payments p
       join installments inst on inst.id = p.installment_id
       join investments v on v.id = inst.investment_id
      where v.investor_id = ?1 ${statusSql}
      order by p.created_at desc
      limit ?${params.length}`,
    params,
  );
  return res.rows;
}

/**
 * "Pay now" for one of the investor's own open installments: (re)issues the
 * standard payment link and returns it, so the existing /pay/:token bKash
 * flow handles the money exactly like an SMS link does.
 */
export async function issueOwnPayLink(investorId, installmentId, req) {
  const own = await query(
    `select inst.id, inst.status from installments inst
       join investments v on v.id = inst.investment_id
      where inst.id = ?1 and v.investor_id = ?2`,
    [installmentId, investorId],
  );
  if (!own.rows[0]) throw notFound('Installment not found');
  if (['PAID', 'WAIVED', 'CANCELLED'].includes(own.rows[0].status)) {
    throw badRequest('This installment is already settled');
  }
  const issued = await issueToken(installmentId, { actor: null, req });
  return { token: issued.token, url: issued.url ?? buildPayUrl(issued.token), path: `/pay/${issued.token}`, expires_at: issued.token_expires_at };
}

/** Ownership check used before serving a receipt to the investor. */
export async function assertOwnPayment(investorId, paymentId) {
  const res = await query(
    `select p.id from payments p
       join installments inst on inst.id = p.installment_id
       join investments v on v.id = inst.investment_id
      where p.id = ?1 and v.investor_id = ?2`,
    [paymentId, investorId],
  );
  if (!res.rows[0]) throw notFound('Payment not found');
  return true;
}
