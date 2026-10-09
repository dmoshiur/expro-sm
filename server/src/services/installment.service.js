/**
 * Installments: status derivation, edits (amount / due date), waive / cancel /
 * reinstate, payment application and the overdue sweep.
 *
 * Invariant: sum(installments.amount) == investment.total_amount.
 * It is enforced by the service (inside a transaction) AND by a deferred DB
 * constraint trigger, so a bad write can never be committed.
 */
import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { dhakaDate, isWeekendDhaka, isoDateOnly } from '../utils/dates.js';
import * as audit from './audit.service.js';
import { generateSessionToken, hashToken } from './crypto.service.js';
import { config } from '../config/index.js';

export const INSTALLMENT_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED'];
export const OPEN_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'];

const SORTABLE = ['serial', 'due_date', 'amount', 'status', 'created_at', 'paid_at'];

export function outstandingPoisha(installment) {
  return Math.max(0, Number(installment.amount) - Number(installment.amount_paid ?? 0));
}

/**
 * Derives the effective status of an installment. WAIVED/CANCELLED/PAID are
 * terminal; everything else depends on how much was paid and on the Dhaka date.
 */
export function deriveStatus(installment, today = dhakaDate()) {
  const status = String(installment.status);
  if (['WAIVED', 'CANCELLED', 'PAID'].includes(status)) return status;
  const paid = Number(installment.amount_paid ?? 0);
  const amount = Number(installment.amount);
  if (paid >= amount) return 'PAID';
  const due = isoDateOnly(installment.due_date);
  if (due < today) return 'OVERDUE';
  if (paid > 0) return 'PARTIALLY_PAID';
  return 'PENDING';
}

/** Recompute + persist the derived status when it differs (no-op otherwise). */
export async function syncStatus(client, installmentId, { today = dhakaDate() } = {}) {
  const res = await client.query('select * from installments where id = $1 for update', [installmentId]);
  const row = res.rows[0];
  if (!row) throw notFound('Installment not found');
  const derived = deriveStatus(row, today);
  if (derived === row.status) return row;
  const paidAt = derived === 'PAID' ? row.paid_at ?? new Date() : null;
  const updated = await client.query(
    'update installments set status = $2, paid_at = $3 where id = $1 returning *',
    [installmentId, derived, paidAt],
  );
  return updated.rows[0];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const INSTALLMENT_SELECT = `
  select inst.*, v.investor_id, v.total_amount as investment_total, v.installment_count, v.status as investment_status,
         i.name as investor_name, i.mobile as investor_mobile, i.status as investor_status,
         greatest(inst.amount - inst.amount_paid, 0)::bigint as outstanding,
         (inst.pay_token_hash is not null and inst.token_expires_at > now()
           and inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')) as pay_link_active
    from installments inst
    join investments v on v.id = inst.investment_id
    join investors i on i.id = v.investor_id`;

export async function getInstallment(id, client = undefined) {
  const res = await query(`${INSTALLMENT_SELECT} where inst.id = $1`, [id], client);
  if (!res.rows[0]) throw notFound('Installment not found');
  return res.rows[0];
}

export async function getInstallmentByToken(tokenHash, client = undefined) {
  const res = await query(`${INSTALLMENT_SELECT} where inst.pay_token_hash = $1`, [tokenHash], client);
  return res.rows[0] ?? null;
}

export async function listInstallments(filters = {}, client = undefined) {
  const where = [];
  const params = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filters.investmentId) where.push(`inst.investment_id = ${push(filters.investmentId)}`);
  if (filters.investorId) where.push(`v.investor_id = ${push(filters.investorId)}`);
  if (filters.status) {
    const list = Array.isArray(filters.status) ? filters.status : [filters.status];
    where.push(`inst.status = any(${push(list)})`);
  }
  if (filters.openOnly) where.push(`inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')`);
  if (filters.dueFrom) where.push(`inst.due_date >= ${push(filters.dueFrom)}`);
  if (filters.dueTo) where.push(`inst.due_date <= ${push(filters.dueTo)}`);
  if (filters.overdueAsOf) where.push(`inst.due_date < ${push(filters.overdueAsOf)} and inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')`);
  if (filters.search) {
    const term = `%${String(filters.search).toLowerCase().trim()}%`;
    where.push(`(i.search_text like ${push(term)} or cast(inst.serial as text) = $${params.length})`);
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const sortColumn = SORTABLE.includes(filters.sort) ? filters.sort : 'due_date';
  const dir = String(filters.dir).toLowerCase() === 'desc' ? 'desc' : 'asc';
  const limit = Math.min(Number(filters.limit) || 25, 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const rows = await query(
    `${INSTALLMENT_SELECT} ${whereSql} order by inst.${sortColumn} ${dir}, inst.id asc limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const total = await query(
    `select count(*)::int as count from installments inst
       join investments v on v.id = inst.investment_id
       join investors i on i.id = v.investor_id ${whereSql}`,
    params.slice(0, params.length - 2),
    client,
  );
  return { rows: rows.rows, total: total.rows[0].count, limit, offset };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------
/**
 * Update an installment's amount and/or due date. Payment links are refreshed
 * when the due date moves. The investment total never changes here, so a plain
 * amount edit must be balanced by the caller only if they also move money to
 * another installment (the UI does this live).
 */
export async function updateInstallment(id, changes, actor, req) {
  return withTransaction(async (client) => {
    const current = await client.query(`${INSTALLMENT_SELECT} where inst.id = $1 for update`, [id]);
    const before = current.rows[0];
    if (!before) throw notFound('Installment not found');
    if (before.status === 'PAID') throw conflict('A paid installment cannot be edited');
    if (before.status === 'CANCELLED') throw conflict('A cancelled installment cannot be edited');

    const sets = [];
    // $1 is the row id in the WHERE clause; SET params start at $2.
    const params = [id];
    const push = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (changes.amount !== undefined) {
      if (Number(changes.amount) < Number(before.amount_paid)) {
        throw badRequest('Amount cannot be lower than the amount already paid');
      }
      sets.push(`amount = ${push(changes.amount)}`);
    }
    if (changes.due_date !== undefined) sets.push(`due_date = ${push(changes.due_date)}`);
    if (sets.length === 0) return before;

    const res = await client.query(`update installments set ${sets.join(', ')} where id = $1 returning *`, params);
    const after = res.rows[0];

    // Sum invariant (explicit check gives a friendly message before the DB trigger fires).
    const sums = await client.query(
      `select coalesce(sum(amount),0)::bigint as total from installments where investment_id = $1`,
      [before.investment_id],
    );
    const inv = await client.query('select total_amount from investments where id = $1', [before.investment_id]);
    if (Number(sums.rows[0].total) !== Number(inv.rows[0].total_amount)) {
      throw badRequest(
        `Installment amounts must keep adding up to the investment total. Current sum is ${sums.rows[0].total} poisha, expected ${inv.rows[0].total_amount}.`,
        { sum: Number(sums.rows[0].total), expected: Number(inv.rows[0].total_amount) },
      );
    }

    const synced = await syncStatus(client, id);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INSTALLMENT_UPDATED,
        entity: 'installment',
        entityId: id,
        oldValue: { amount: before.amount, due_date: before.due_date, status: before.status },
        newValue: { amount: synced.amount, due_date: synced.due_date, status: synced.status },
        meta: { investmentId: before.investment_id, serial: before.serial },
        actor,
        req,
      },
    );
    return synced;
  });
}

/** WAIVED / CANCELLED / reinstatement to PENDING. Reason required, always audited. */
export async function changeInstallmentState(id, { status, reason }, actor, req) {
  if (!['WAIVED', 'CANCELLED', 'PENDING'].includes(status)) throw badRequest('Unsupported target status');
  return withTransaction(async (client) => {
    const current = await client.query('select * from installments where id = $1 for update', [id]);
    const before = current.rows[0];
    if (!before) throw notFound('Installment not found');
    if (before.status === 'PAID' && status !== 'WAIVED') throw conflict('A paid installment can only be waived');
    if (before.status === status) return before;

    const updated = await client.query(
      `update installments
          set status = $2, status_reason = $3, status_changed_by = $4, status_changed_at = now(),
              paid_at = case when $5::boolean then coalesce(paid_at, now()) else null end
        where id = $1 returning *`,
      [id, status, reason ?? null, actor?.id ?? null, status === 'PAID'],
    );

    const action =
      status === 'WAIVED'
        ? audit.AUDIT_ACTIONS.INSTALLMENT_WAIVED
        : status === 'CANCELLED'
          ? audit.AUDIT_ACTIONS.INSTALLMENT_CANCELLED
          : audit.AUDIT_ACTIONS.INSTALLMENT_REINSTATED;

    await audit.record(
      {
        action,
        entity: 'installment',
        entityId: id,
        oldValue: { status: before.status },
        newValue: { status, reason: reason ?? null },
        meta: { investmentId: before.investment_id, serial: before.serial },
        actor,
        req,
      },
    );

    // Recompute the parent investment status (COMPLETED once nothing is open).
    await refreshInvestmentStatus(client, before.investment_id);
    return updated.rows[0];
  });
}

/** AUTO transition used by the overdue job - audited once per run, not per row. */
export async function markOverdue({ asOf = dhakaDate(), actor = null, req = null } = {}) {
  return withTransaction(async (client) => {
    const res = await client.query(
      `update installments
          set status = 'OVERDUE', status_changed_at = now()
        where due_date < $1 and status in ('PENDING', 'PARTIALLY_PAID')
        returning id, investment_id, serial, amount, due_date, status`,
      [asOf],
    );
    if (res.rowCount > 0) {
      await audit.record(
        {
          action: audit.AUDIT_ACTIONS.INSTALLMENT_OVERDUE_MARKED,
          entity: 'installment',
          entityId: res.rows.length === 1 ? res.rows[0].id : null,
          newValue: { status: 'OVERDUE', count: res.rowCount },
          meta: { installmentIds: res.rows.map((r) => r.id).slice(0, 200), asOf },
          actor,
          req,
        },
      );
    }
    return res.rows;
  });
}

export async function refreshInvestmentStatus(client, investmentId) {
  const res = await client.query(
    `select count(*)::int as open_count,
            count(*) filter (where status = 'PAID')::int as paid_count,
            count(*)::int as total_count
       from installments
      where investment_id = $1 and status in ('PENDING','PARTIALLY_PAID','OVERDUE')`,
    [investmentId],
  );
  const { open_count: openCount } = res.rows[0];
  const inv = await client.query('select status from investments where id = $1', [investmentId]);
  const currentStatus = inv.rows[0]?.status;
  let next = currentStatus;
  if (currentStatus === 'CANCELLED') next = 'CANCELLED';
  else next = openCount === 0 ? 'COMPLETED' : 'ACTIVE';
  if (next !== currentStatus) {
    await client.query('update investments set status = $2 where id = $1', [investmentId, next]);
  }
  return next;
}

/** Applies a verified payment (poisha) to an installment inside a transaction. */
export async function applyPayment(client, installmentId, amountPoisha) {
  const res = await client.query('select * from installments where id = $1 for update', [installmentId]);
  const row = res.rows[0];
  if (!row) throw notFound('Installment not found');
  if (row.status === 'CANCELLED') throw conflict('This installment is cancelled');
  const paid = Number(row.amount_paid) + Number(amountPoisha);
  if (paid > Number(row.amount)) {
    throw conflict('Payment would exceed the installment amount', {
      amount: Number(row.amount),
      alreadyPaid: Number(row.amount_paid),
      attempted: Number(amountPoisha),
    });
  }
  const status = paid >= Number(row.amount) ? 'PAID' : 'PARTIALLY_PAID';
  const updated = await client.query(
    `update installments
        set amount_paid = $2, status = $3, paid_at = case when $4::boolean then now() else paid_at end
      where id = $1 returning *`,
    [installmentId, paid, status, status === 'PAID'],
  );
  await refreshInvestmentStatus(client, row.investment_id);
  return updated.rows[0];
}

/**
 * Reverses a previously applied payment (voiding a manual entry, correcting a
 * mistake). Only amount_paid moves, so the sum-of-installments invariant is
 * untouched; the status is recomputed and the investment status refreshed.
 */
export async function revertPayment(client, installmentId, amountPoisha) {
  const res = await client.query('select * from installments where id = $1 for update', [installmentId]);
  const row = res.rows[0];
  if (!row) throw notFound('Installment not found');
  const paid = Math.max(0, Number(row.amount_paid) - Number(amountPoisha));
  const status = paid <= 0 ? 'PENDING' : paid >= Number(row.amount) ? 'PAID' : 'PARTIALLY_PAID';
  // A dedicated boolean parameter: reusing $3 inside the CASE made Postgres
  // infer conflicting types for it (42P08).
  const updated = await client.query(
    `update installments
        set amount_paid = $2, status = $3,
            paid_at = case when $4::boolean then paid_at else null end
      where id = $1 returning *`,
    [installmentId, paid, status, status === 'PAID'],
  );
  await refreshInvestmentStatus(client, row.investment_id);
  return updated.rows[0];
}

// ---------------------------------------------------------------------------
// Payment tokens (see also services/paylink.service.js)
// ---------------------------------------------------------------------------
export function buildToken() {
  const token = generateSessionToken();
  return { token, tokenHash: hashToken(token) };
}

export function tokenExpiry(days = config.paymentLink.ttlDays, from = new Date()) {
  return new Date(from.getTime() + days * 86_400_000);
}

/** Bangladesh weekend hint used by the UI when suggesting a due date. */
export function isWeekend(dateIso) {
  return isWeekendDhaka(dateIso);
}
