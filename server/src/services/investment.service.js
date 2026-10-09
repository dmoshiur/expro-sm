/**
 * Investments: creation with an auto-split installment schedule, listing,
 * detail, total adjustments, cancellation.
 *
 * INVARIANT: sum(installments.amount) == investments.total_amount, always
 * enforced inside a transaction and again by a deferred DB constraint trigger.
 */
import { query, withTransaction } from '../db/client.js';
import { NOW } from '../db/sql.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { buildInstallmentPlan, splitAmount } from '../utils/money.js';
import { dhakaDate } from '../utils/dates.js';
import * as audit from './audit.service.js';
import {
  deriveStatus,
  syncStatus,
  refreshInvestmentStatus,
  buildToken,
  tokenExpiry,
  assertInvestmentSchedule,
} from './installment.service.js';

export const INVESTMENT_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'];
const SORTABLE = ['created_at', 'total_amount', 'status', 'installment_count'];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const INVESTMENT_SELECT = `
  select v.*, i.name as investor_name, i.mobile as investor_mobile, i.status as investor_status,
         (select count(*) from installments inst where inst.investment_id = v.id) as installment_rows,
         (select coalesce(sum(inst.amount_paid), 0) from installments inst where inst.investment_id = v.id) as amount_collected,
         (select coalesce(sum(inst.amount), 0) from installments inst
           where inst.investment_id = v.id and inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')) as amount_outstanding,
         (select count(*) from installments inst
           where inst.investment_id = v.id and inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')) as open_installments,
         (select min(inst.due_date) from installments inst
           where inst.investment_id = v.id and inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')) as next_due_date
    from investments v
    join investors i on i.id = v.investor_id`;

export async function getInvestment(id, client = undefined) {
  const res = await query(`${INVESTMENT_SELECT} where v.id = ?1`, [id], client);
  if (!res.rows[0]) throw notFound('Investment not found');
  return res.rows[0];
}

export async function listInvestments(filters = {}, client = undefined) {
  const where = ['i.deleted_at is null'];
  const params = [];
  const push = (v) => {
    params.push(v);
    return `?${params.length}`;
  };
  if (filters.investorId) where.push(`v.investor_id = ${push(filters.investorId)}`);
  if (filters.status) where.push(`v.status = ${push(filters.status)}`);
  if (filters.search) {
    const term = `%${String(filters.search).toLowerCase().trim()}%`;
    where.push(`(i.search_text like ${push(term)} or cast(v.id as text) = ?${params.length})`);
  }
  if (filters.hasOverdue) {
    where.push(`exists (select 1 from installments inst where inst.investment_id = v.id and inst.status = 'OVERDUE')`);
  }
  const whereSql = `where ${where.join(' and ')}`;
  const sortColumn = SORTABLE.includes(filters.sort) ? filters.sort : 'created_at';
  const dir = String(filters.dir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Number(filters.limit) || 25, 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const rows = await query(
    `${INVESTMENT_SELECT} ${whereSql} order by v.${sortColumn} ${dir}, v.id desc limit ${push(limit)} offset ${push(offset)}`,
    params,
    client,
  );
  const total = await query(
    `select count(*) as count from investments v join investors i on i.id = v.investor_id ${whereSql}`,
    params.slice(0, params.length - 2),
    client,
  );

  // Totals for the whole (unfiltered-by-page) result set: per-investment collected sums
  // over the same filtered rows.
  const totals = await query(
    `select coalesce(sum(v.total_amount), 0) as total_amount,
            coalesce(sum((select coalesce(sum(inst.amount_paid), 0) from installments inst
                           where inst.investment_id = v.id)), 0) as amount_collected
       from investments v join investors i on i.id = v.investor_id ${whereSql}`,
    params.slice(0, params.length - 2),
    client,
  );

  return { rows: rows.rows, total: total.rows[0].count, limit, offset, totals: totals.rows[0] };
}

export async function getInvestmentDetail(id, client = undefined) {
  const investment = await getInvestment(id, client);
  const installments = await query(
    `select inst.*, max(inst.amount - inst.amount_paid, 0) as outstanding,
            (inst.pay_token_hash is not null and inst.token_expires_at > ${NOW}) as pay_link_active,
            (select count(*) from payments p where p.installment_id = inst.id) as payment_count,
            (select coalesce(sum(p.amount),0) from payments p where p.installment_id = inst.id and p.status = 'SUCCESS') as amount_paid_success
       from installments inst where inst.investment_id = ?1 order by inst.serial asc`,
    [id],
    client,
  );
  const payments = await query(
    `select p.*, a.name as recorded_by_name
       from payments p
       join installments inst on inst.id = p.installment_id
       left join admins a on a.id = p.recorded_by_admin_id
      where inst.investment_id = ?1
      order by p.created_at desc limit 200`,
    [id],
    client,
  );
  return { ...investment, installments: installments.rows, payments: payments.rows };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createInvestment(data, actor, req) {
  const { investorId, totalAmount, installmentCount, firstDueDate, interval = 'MONTHLY', title, notes } = data;
  return withTransaction(async (client) => {
    const investor = await client.query('select id, name, status, deleted_at from investors where id = ?1', [investorId]);
    const inv = investor.rows[0];
    if (!inv) throw notFound('Investor not found');
    if (inv.deleted_at) throw badRequest('Cannot add an investment to a deleted investor');
    if (inv.status === 'CLOSED') throw badRequest('Cannot add an investment to a closed investor');

    const plan = buildInstallmentPlan({ totalAmount, installmentCount, firstDueDate, interval });

    const inserted = await client.query(
      `insert into investments (investor_id, title, total_amount, installment_count, interval, first_due_date, notes, created_by, updated_by, status)
       values (?1,?2,?3,?4,?5,?6,?7,?8,?8,'ACTIVE') returning *`,
      [investorId, title ?? null, totalAmount, installmentCount, interval, firstDueDate, notes ?? null, actor?.id ?? null],
    );
    const investment = inserted.rows[0];

    const installments = [];
    for (const item of plan) {
      const token = buildToken();
      const expiresAt = tokenExpiry();
      const res = await client.query(
        `insert into installments (investment_id, serial, amount, due_date, status, pay_token_hash, token_expires_at, token_issued_at)
         values (?1,?2,?3,?4,'PENDING',?5,?6,${NOW}) returning *`,
        [investment.id, item.serial, item.amount, item.dueDate, token.tokenHash, expiresAt],
      );
      installments.push({ ...res.rows[0], pay_token: token.token });
    }

    // Fail loudly if the split ever drifts from the total.
    const sum = installments.reduce((s, i) => s + Number(i.amount), 0);
    if (sum !== Number(totalAmount)) {
      throw conflict('Internal error: installment split does not match the investment total', { sum, totalAmount });
    }

    await refreshInvestmentStatus(client, investment.id);
    // Service-layer replacement for the deferred "installments must total the investment" trigger.
    await assertInvestmentSchedule(client, investment.id);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTMENT_CREATED,
        entity: 'investment',
        entityId: investment.id,
        newValue: {
          investor_id: investorId,
          total_amount: totalAmount,
          installment_count: installmentCount,
          interval,
          first_due_date: firstDueDate,
          schedule: plan.map((p) => ({ serial: p.serial, amount: p.amount, due_date: p.dueDate })),
        },
        actor,
        req,
      },
    );

    return { investment, installments, plan };
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
/**
 * Change the investment total. The difference is redistributed over the
 * installments that are still open (never touching paid/waived/cancelled rows),
 * spread as evenly as poisha allow with the remainder on the last open row, so
 * the sum always equals the total exactly.
 */
export async function changeInvestmentTotal(id, { totalAmount, reason, strategy = 'REDISTRIBUTE' }, actor, req) {
  return withTransaction(async (client) => {
    const current = await client.query('select * from investments where id = ?1 ', [id]);
    const before = current.rows[0];
    if (!before) throw notFound('Investment not found');
    if (Number(totalAmount) === Number(before.total_amount)) return before;

    const rows = await client.query('select * from installments where investment_id = ?1 order by serial ', [id]);
    const fixed = rows.rows.filter((r) => ['PAID', 'WAIVED', 'CANCELLED'].includes(r.status));
    const open = rows.rows.filter((r) => !['PAID', 'WAIVED', 'CANCELLED'].includes(r.status));
    if (open.length === 0) throw conflict('All installments are settled; nothing left to redistribute');

    const fixedTotal = fixed.reduce((s, r) => s + Number(r.amount), 0);
    const paidTotal = fixed.filter((r) => r.status === 'PAID').reduce((s, r) => s + Number(r.amount), 0);
    if (Number(totalAmount) < fixedTotal) {
      throw badRequest(
        `New total cannot be lower than the settled installments (${fixedTotal} poisha)`,
        { settled: fixedTotal, paid: paidTotal },
      );
    }
    if (strategy === 'SCALE' ) {
      // scale open installments proportionally to the previous open total
      const previousOpen = open.reduce((s, r) => s + Number(r.amount), 0);
      const targetOpen = Number(totalAmount) - fixedTotal;
      let assigned = 0;
      open.forEach((row, index) => {
        const isLast = index === open.length - 1;
        const value = isLast ? targetOpen - assigned : Math.max(1, Math.floor((Number(row.amount) / previousOpen) * targetOpen));
        assigned += value;
        row.newAmount = value;
      });
    } else {
      const targetOpen = Number(totalAmount) - fixedTotal;
      if (targetOpen < open.length) throw badRequest('New total is too small for the number of open installments');
      const each = Math.floor(targetOpen / open.length);
      const remainder = targetOpen - each * open.length;
      open.forEach((row, index) => {
        row.newAmount = each + (index === open.length - 1 ? remainder : 0);
      });
    }

    for (const row of open) {
      if (Number(row.newAmount) === Number(row.amount)) continue;
      if (Number(row.newAmount) < Number(row.amount_paid)) {
        throw badRequest(`Installment #${row.serial} already has more paid than its new amount`);
      }
      await client.query('update installments set amount = ?2 where id = ?1', [row.id, row.newAmount]);
    }
    await client.query(`update investments set total_amount = ?2, updated_by = ?3, updated_at = ${NOW} where id = ?1`, [
      id,
      totalAmount,
      actor?.id ?? null,
    ]);

    // Verify the invariant explicitly before COMMIT (replaces the deferred DB trigger).
    const sums = await client.query('select coalesce(sum(amount),0) as total from installments where investment_id = ?1', [id]);
    if (Number(sums.rows[0].total) !== Number(totalAmount)) {
      throw conflict('Redistribution failed to preserve the total', { sum: Number(sums.rows[0].total) });
    }
    await assertInvestmentSchedule(client, id);

    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTMENT_TOTAL_CHANGED,
        entity: 'investment',
        entityId: id,
        oldValue: { total_amount: Number(before.total_amount) },
        newValue: { total_amount: Number(totalAmount), strategy, reason: reason ?? null },
        meta: { redistributed: open.map((r) => ({ serial: r.serial, from: Number(r.amount), to: Number(r.newAmount) })) },
        actor,
        req,
      },
    );

    const updated = await client.query(`${INVESTMENT_SELECT} where v.id = ?1`, [id]);
    return updated.rows[0];
  });
}

export async function setInvestmentStatus(id, status, { reason }, actor, req) {
  if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(status)) throw badRequest('Invalid status');
  return withTransaction(async (client) => {
    const current = await client.query('select * from investments where id = ?1 ', [id]);
    const before = current.rows[0];
    if (!before) throw notFound('Investment not found');
    if (status === 'CANCELLED') {
      const paid = await client.query(
        `select count(*) as count from installments where investment_id = ?1 and amount_paid > 0`,
        [id],
      );
      if (paid.rows[0].count > 0 && !reason) {
        throw badRequest('A reason is required to cancel an investment that already has payments');
      }
    }
    const res = await client.query(`update investments set status = ?2, updated_by = ?3, updated_at = ${NOW} where id = ?1 returning *`, [
      id,
      status,
      actor?.id ?? null,
    ]);
    await audit.record(
      {
        action: audit.AUDIT_ACTIONS.INVESTMENT_STATUS_CHANGED,
        entity: 'investment',
        entityId: id,
        oldValue: { status: before.status },
        newValue: { status, reason: reason ?? null },
        actor,
        req,
      },
    );
    return res.rows[0];
  });
}

/** Re-derive every installment status of an investment (used after edits). */
export async function resyncSchedule(investmentId, actor = null) {
  return withTransaction(async (client) => {
    const rows = await client.query('select id from installments where investment_id = ?1 order by serial', [investmentId]);
    const out = [];
    for (const row of rows.rows) out.push(await syncStatus(client, row.id));
    await refreshInvestmentStatus(client, investmentId);
    return out;
  });
}

export async function schedulePreview({ totalAmount, installmentCount, firstDueDate, interval }) {
  const plan = buildInstallmentPlan({ totalAmount, installmentCount, firstDueDate, interval });
  return { plan, sum: plan.reduce((s, p) => s + p.amount, 0), today: dhakaDate() };
}

export { splitAmount, deriveStatus };
