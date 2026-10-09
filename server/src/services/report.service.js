/**
 * Dashboard KPIs and reports. All money in poisha; formatting happens in the UI.
 * Date bucketing is Asia/Dhaka based (see utils/dates.js).
 */
import { query } from '../db/client.js';
import { addDays, addMonths, dhakaDate, dhakaMonthStart, diffDays, isoDateOnly, monthKeysBetween } from '../utils/dates.js';

// SQLite date helpers. Timestamps are stored as UTC ISO strings, so a calendar day
// is compared as [dayStart(day), dayStart(day + 1)). Date columns are 'YYYY-MM-DD' text.
const dayStart = (day) => `${String(day).slice(0, 10)}T00:00:00.000Z`;
const monthsAgoIso = (months) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - Number(months));
  return d.toISOString();
};
import { formatBDT } from '../utils/money.js';
import { maskMobile } from '../utils/mask.js';
import { toCsv, poishaToDecimalString, csvFilename } from '../utils/csv.js';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export async function dashboard({ range = '30d' } = {}, client = undefined) {
  const today = dhakaDate();
  const monthStart = dhakaMonthStart();
  const soonTo = addDays(today, 7);

  const [kpis, byStatus, collections, dueSoon, overdue, recentPayments, recentActivity] = await Promise.all([
    query(
      `select
         (select coalesce(sum(total_amount),0) from investments where status <> 'CANCELLED') as total_invested,
         (select count(*) from investments where status <> 'CANCELLED') as investment_count,
         (select count(*) from investors where deleted_at is null) as investor_count,
         (select count(*) from investors where deleted_at is null and status = 'ACTIVE') as active_investor_count,
         (select coalesce(sum(amount_paid),0) from installments) as total_collected,
         (select coalesce(sum(amount),0) from installments
            where status in ('PENDING','PARTIALLY_PAID','OVERDUE')) as total_outstanding,
         (select coalesce(sum(p.amount),0) from payments p
            where p.status = 'SUCCESS' and p.paid_at >= ?4 and p.paid_at < ?5) as today_collection,
         (select count(*) from payments p
            where p.status = 'SUCCESS' and p.paid_at >= ?4 and p.paid_at < ?5) as today_payment_count,
         (select coalesce(sum(p.amount),0) from payments p
            where p.status = 'SUCCESS' and p.paid_at >= ?2) as month_collection,
         (select coalesce(sum(inst.amount - inst.amount_paid),0) from installments inst
            where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')
              and inst.due_date > ?1 and inst.due_date <= ?3) as upcoming_due_amount,
         (select count(*) from installments inst
            where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')
              and inst.due_date > ?1 and inst.due_date <= ?3) as upcoming_due_count,
         (select coalesce(sum(inst.amount - inst.amount_paid),0) from installments inst
            where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE') and inst.due_date < ?1) as overdue_amount,
         (select count(*) from installments inst
            where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE') and inst.due_date < ?1) as overdue_count,
         (select count(*) from installments inst where inst.status = 'PAID') as paid_installment_count,
         (select count(*) from installments inst where inst.status in ('WAIVED','CANCELLED')) as settled_other_count`,
      [today, dayStart(monthStart), soonTo, dayStart(today), dayStart(addDays(today, 1))],
      client,
    ),
    query(
      `select status, count(*) as count, coalesce(sum(amount),0) as amount
         from installments group by status order by status`,
      [],
      client,
    ),
    query(
      `select strftime('%Y-%m', p.paid_at) as month,
              coalesce(sum(p.amount),0) as amount,
              count(*) as payments
         from payments p
        where p.status = 'SUCCESS' and p.paid_at >= ?1
        group by 1 order by 1 asc`,
      [monthsAgoIso(12)],
      client,
    ),
    query(
      `select inst.id, inst.serial, inst.amount - inst.amount_paid as outstanding, inst.due_date, inst.status,
              v.id as investment_id, i.id as investor_id, i.name as investor_name, i.mobile as investor_mobile
         from installments inst
         join investments v on v.id = inst.investment_id
         join investors i on i.id = v.investor_id
        where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE')
          and inst.due_date between ?1 and ?2
        order by inst.due_date asc limit 25`,
      [today, addDays(today, 30)],
      client,
    ),
    query(
      `select inst.id, inst.serial, inst.amount - inst.amount_paid as outstanding, inst.due_date, inst.status,
              v.id as investment_id, i.id as investor_id, i.name as investor_name, i.mobile as investor_mobile
         from installments inst
         join investments v on v.id = inst.investment_id
         join investors i on i.id = v.investor_id
        where inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE') and inst.due_date < ?1
        order by inst.due_date asc limit 25`,
      [today],
      client,
    ),
    query(
      `select p.id, p.amount, p.method, p.status, p.trx_id, p.manual_reference, p.paid_at, p.created_at,
              inst.serial as installment_serial, i.name as investor_name, i.id as investor_id
         from payments p
         join installments inst on inst.id = p.installment_id
         join investments v on v.id = inst.investment_id
         join investors i on i.id = v.investor_id
        order by p.created_at desc limit 10`,
      [],
      client,
    ),
    query(
      `select a.id, a.action, a.entity, a.entity_id, a.actor_email, a.created_at
         from audit_logs a order by a.created_at desc limit 8`,
      [],
      client,
    ),
  ]);

  const k = kpis.rows[0];
  const totalCollected = Number(k.total_collected);
  const totalInvested = Number(k.total_invested);

  return {
    generatedAt: new Date().toISOString(),
    today,
    timeZone: 'Asia/Dhaka',
    kpis: {
      totalInvested,
      totalCollected,
      totalOutstanding: Number(k.total_outstanding),
      collectionRate: totalInvested > 0 ? Math.round((totalCollected / totalInvested) * 1000) / 10 : 0,
      todayCollection: Number(k.today_collection),
      todayPaymentCount: k.today_payment_count,
      monthCollection: Number(k.month_collection),
      upcomingDueAmount: Number(k.upcoming_due_amount),
      upcomingDueCount: k.upcoming_due_count,
      overdueAmount: Number(k.overdue_amount),
      overdueCount: k.overdue_count,
      investorCount: k.investor_count,
      activeInvestorCount: k.active_investor_count,
      investmentCount: k.investment_count,
      paidInstallmentCount: k.paid_installment_count,
    },
    installmentsByStatus: byStatus.rows,
    collectionsByMonth: collections.rows,
    upcomingDue: dueSoon.rows,
    overdue: overdue.rows,
    recentPayments: recentPayments.rows,
    recentActivity: recentActivity.rows,
    range,
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
const OPEN = `('PENDING','PARTIALLY_PAID','OVERDUE')`;

export async function collectionByMonth({ months = 12 } = {}, client = undefined) {
  const rows = await query(
    `select strftime('%Y-%m', p.paid_at) as month,
            coalesce(sum(p.amount),0) as amount,
            count(*) as payment_count,
            coalesce(sum(p.amount) filter (where p.method = 'BKASH'), 0) as bkash_amount,
            coalesce(sum(p.amount) filter (where p.method = 'CASH'), 0) as cash_amount,
            coalesce(sum(p.amount) filter (where p.method = 'BANK'), 0) as bank_amount
       from payments p
      where p.status = 'SUCCESS' and p.paid_at >= ?1
      group by 1 order by 1 asc`,
    [monthsAgoIso(Number(months))],
    client,
  );
  const filled = fillMonths(rows.rows, Number(months));
  const total = filled.reduce((s, r) => s + Number(r.amount), 0);
  return { months: filled, total };
}

function fillMonths(rows, months) {
  const today = dhakaDate();
  const keys = monthKeysBetween(addMonths(`${today.slice(0, 7)}-01`, -(months - 1)), today);
  const map = new Map(rows.map((r) => [r.month, r]));
  return keys.map((key) => {
    const row = map.get(key);
    return {
      month: key,
      amount: Number(row?.amount ?? 0),
      paymentCount: row?.payment_count ?? 0,
      bkashAmount: Number(row?.bkash_amount ?? 0),
      cashAmount: Number(row?.cash_amount ?? 0),
      bankAmount: Number(row?.bank_amount ?? 0),
    };
  });
}

export async function dueReport({ from, to, status = null, investorId = null, limit = 500 } = {}, client = undefined) {
  const where = [`inst.status in ${OPEN}`];
  // ?1 is the "today" anchor used in the select list, so filter params must
  // start at ?2 (the previous version reused ?1 for `from`, which made Postgres
  // infer a date where the LIMIT expected a bigint).
  const params = [dhakaDate()];
  const push = (v) => {
    params.push(v);
    return `?${params.length}`;
  };
  if (from) where.push(`inst.due_date >= ${push(from)}`);
  if (to) where.push(`inst.due_date <= ${push(to)}`);
  if (status) where.push(`inst.status = ${push(status)}`);
  if (investorId) where.push(`i.id = ${push(investorId)}`);
  const rows = await query(
    `select inst.id, inst.serial, inst.amount, inst.amount_paid, (inst.amount - inst.amount_paid) as outstanding,
            inst.due_date, inst.status, v.id as investment_id, v.total_amount as investment_total,
            i.id as investor_id, i.name as investor_name, i.mobile as investor_mobile,
            CAST(round(julianday(?1) - julianday(inst.due_date)) AS INTEGER) as days_from_today
       from installments inst
       join investments v on v.id = inst.investment_id
       join investors i on i.id = v.investor_id
      where ${where.join(' and ')}
      order by inst.due_date asc limit ${push(limit)}`,
    params,
    client,
  );
  const summary = {
    count: rows.rows.length,
    amount: rows.rows.reduce((s, r) => s + Number(r.amount), 0),
    outstanding: rows.rows.reduce((s, r) => s + Number(r.outstanding), 0),
    overdueCount: rows.rows.filter((r) => r.days_from_today > 0).length,
    overdueAmount: rows.rows.filter((r) => r.days_from_today > 0).reduce((s, r) => s + Number(r.outstanding), 0),
  };
  return { rows: rows.rows, summary };
}

export async function overdueReport({ asOf = null, limit = 500 } = {}, client = undefined) {
  const today = asOf ?? dhakaDate();
  const rows = await query(
    `select inst.id, inst.serial, inst.amount, inst.amount_paid, (inst.amount - inst.amount_paid) as outstanding,
            inst.due_date, inst.status, v.id as investment_id,
            i.id as investor_id, i.name as investor_name, i.mobile as investor_mobile,
            CAST(round(julianday(?1) - julianday(inst.due_date)) AS INTEGER) as days_overdue
       from installments inst
       join investments v on v.id = inst.investment_id
       join investors i on i.id = v.investor_id
      where inst.status in ${OPEN} and inst.due_date < ?1
      order by inst.due_date asc limit ${Number(limit)}`,
    [today],
    client,
  );
  const buckets = { '1-15': 0, '16-30': 0, '31-60': 0, '60+': 0 };
  for (const row of rows.rows) {
    const d = Number(row.days_overdue);
    if (d <= 15) buckets['1-15'] += Number(row.outstanding);
    else if (d <= 30) buckets['16-30'] += Number(row.outstanding);
    else if (d <= 60) buckets['31-60'] += Number(row.outstanding);
    else buckets['60+'] += Number(row.outstanding);
  }
  return {
    rows: rows.rows,
    summary: {
      count: rows.rows.length,
      outstanding: rows.rows.reduce((s, r) => s + Number(r.outstanding), 0),
      buckets,
      asOf: today,
    },
  };
}

export async function investorStatement({ investorId, from = null, to = null } = {}, client = undefined) {
  const investor = await query(
    `select id, name, mobile, status, address, created_at from investors where id = ?1`,
    [investorId],
    client,
  );
  if (!investor.rows[0]) return null;

  const investments = await query(
    `select v.id, v.total_amount, v.installment_count, v.status, v.created_at,
            coalesce(sum(inst.amount_paid),0) as collected,
            coalesce(sum(case when inst.status in ${OPEN} then inst.amount - inst.amount_paid else 0 end),0) as outstanding
       from investments v
       left join installments inst on inst.investment_id = v.id
      where v.investor_id = ?1 group by v.id order by v.created_at desc`,
    [investorId],
    client,
  );

  const payments = await query(
    `select p.id, p.amount, p.method, p.status, p.trx_id, p.manual_reference, p.paid_at, p.created_at,
            inst.serial as installment_serial, v.id as investment_id
       from payments p
       join installments inst on inst.id = p.installment_id
       join investments v on v.id = inst.investment_id
      where v.investor_id = ?1
        and (?2 is null or p.created_at >= ?2)
        and (?3 is null or p.created_at < ?3)
      order by p.created_at desc`,
    [investorId, from ? dayStart(from) : null, to ? dayStart(addDays(to, 1)) : null],
    client,
  );

  const schedule = await query(
    `select inst.id, inst.serial, inst.amount, inst.amount_paid, (inst.amount - inst.amount_paid) as outstanding,
            inst.due_date, inst.status, v.id as investment_id
       from installments inst join investments v on v.id = inst.investment_id
      where v.investor_id = ?1 order by v.id asc, inst.serial asc`,
    [investorId],
    client,
  );

  return {
    investor: { ...investor.rows[0], mobile_masked: maskMobile(investor.rows[0].mobile) },
    investments: investments.rows,
    payments: payments.rows,
    schedule: schedule.rows,
    totals: {
      invested: investments.rows.reduce((s, r) => s + Number(r.total_amount), 0),
      collected: investments.rows.reduce((s, r) => s + Number(r.collected), 0),
      outstanding: investments.rows.reduce((s, r) => s + Number(r.outstanding), 0),
    },
  };
}

// ---------------------------------------------------------------------------
// CSV builders (UTF-8 BOM, Excel friendly)
// ---------------------------------------------------------------------------
export function dueReportCsv(report) {
  const header = ['Installment ID', 'Investor', 'Mobile', 'Investment ID', 'Serial', 'Amount (BDT)', 'Paid (BDT)', 'Outstanding (BDT)', 'Due date', 'Status', 'Days from today'];
  const rows = report.rows.map((r) => [
    r.id,
    r.investor_name,
    r.investor_mobile,
    r.investment_id,
    r.serial,
    poishaToDecimalString(r.amount),
    poishaToDecimalString(r.amount_paid),
    poishaToDecimalString(r.outstanding),
    isoDateOnly(r.due_date),
    r.status,
    r.days_from_today,
  ]);
  return { content: toCsv(rows, header), filename: csvFilename('due-report') };
}

export function overdueReportCsv(report) {
  const header = ['Installment ID', 'Investor', 'Mobile', 'Investment ID', 'Serial', 'Outstanding (BDT)', 'Due date', 'Days overdue', 'Status'];
  const rows = report.rows.map((r) => [
    r.id,
    r.investor_name,
    r.investor_mobile,
    r.investment_id,
    r.serial,
    poishaToDecimalString(r.outstanding),
    isoDateOnly(r.due_date),
    r.days_overdue,
    r.status,
  ]);
  return { content: toCsv(rows, header), filename: csvFilename('overdue-report') };
}

export function collectionsCsv(collections) {
  const header = ['Month', 'Collected (BDT)', 'Payments', 'bKash (BDT)', 'Cash (BDT)', 'Bank (BDT)'];
  const rows = collections.months.map((m) => [
    m.month,
    poishaToDecimalString(m.amount),
    m.paymentCount,
    poishaToDecimalString(m.bkashAmount),
    poishaToDecimalString(m.cashAmount),
    poishaToDecimalString(m.bankAmount),
  ]);
  return { content: toCsv(rows, header), filename: csvFilename('collections-by-month') };
}

export function paymentsCsv(payments) {
  const header = [
    'Payment ID',
    'Receipt',
    'Investor',
    'Mobile',
    'Investment ID',
    'Installment #',
    'Amount (BDT)',
    'Method',
    'Status',
    'Trx ID',
    'Manual reference',
    'Paid at',
    'Created at',
  ];
  const rows = payments.rows.map((p) => [
    p.id,
    `RCPT-${new Date(p.paid_at ?? p.created_at).getUTCFullYear()}-${String(p.id).padStart(6, '0')}`,
    p.investor_name,
    p.investor_mobile,
    p.investment_id,
    p.installment_serial,
    poishaToDecimalString(p.amount),
    p.method,
    p.status,
    p.trx_id ?? '',
    p.manual_reference ?? '',
    p.paid_at ? new Date(p.paid_at).toISOString() : '',
    new Date(p.created_at).toISOString(),
  ]);
  return { content: toCsv(rows, header), filename: csvFilename('payments') };
}

export function statementCsv(statement) {
  const header = ['Kind', 'Reference', 'Date', 'Amount (BDT)', 'Status', 'Detail'];
  const rows = [];
  for (const inv of statement.investments) {
    rows.push(['Investment', `#${inv.id}`, new Date(inv.created_at).toISOString().slice(0, 10), poishaToDecimalString(inv.total_amount), inv.status, `${inv.installment_count} installments`]);
  }
  for (const p of statement.payments) {
    rows.push([
      'Payment',
      `PAY-${p.id}`,
      p.paid_at ? new Date(p.paid_at).toISOString().slice(0, 10) : '',
      poishaToDecimalString(p.amount),
      p.status,
      `${p.method}${p.trx_id ? ` trx ${p.trx_id}` : ''}${p.manual_reference ? ` ref ${p.manual_reference}` : ''} (installment #${p.installment_serial})`,
    ]);
  }
  for (const s of statement.schedule) {
    if (!['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(s.status)) continue;
    rows.push([
      'Due',
      `INST-${s.id}`,
      isoDateOnly(s.due_date),
      poishaToDecimalString(s.outstanding),
      s.status,
      `installment #${s.serial} of investment #${s.investment_id}`,
    ]);
  }
  return { content: toCsv(rows, header), filename: csvFilename(`statement-investor-${statement.investor.id}`) };
}

export function investorsCsv(investors) {
  const header = ['Investor ID', 'Name', 'Mobile', 'Status', 'Nominees', 'Investments', 'Total invested (BDT)', 'Collected (BDT)', 'Created at'];
  const rows = investors.rows.map((i) => [
    i.id,
    i.name,
    i.mobile,
    i.status,
    i.nominee_count,
    i.investment_count,
    poishaToDecimalString(i.total_invested),
    poishaToDecimalString(i.total_collected),
    new Date(i.created_at).toISOString().slice(0, 10),
  ]);
  return { content: toCsv(rows, header), filename: csvFilename('investors') };
}

// ---------------------------------------------------------------------------
// Printable HTML report (browser print-to-PDF)
// ---------------------------------------------------------------------------
export function renderReportHtml({ title, subtitle, columns, rows, footer = null }) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #14213d; }
  h1 { font-size: 20px; margin: 0; }
  .muted { color: #64748b; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
  th, td { border-bottom: 1px solid #e5e8ef; padding: 6px 8px; text-align: left; }
  th { background: #f5f7fb; }
  tfoot td { font-weight: 700; }
  .print { margin-top: 12px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #14213d; background: #14213d; color: #fff; cursor: pointer; }
  @media print { .print { display: none; } body { margin: 0; } }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="muted">${esc(subtitle ?? '')} &middot; generated ${esc(new Date().toISOString())} (Asia/Dhaka display)</div>
<div class="print"><button onclick="window.print()">Print / Save as PDF</button></div>
<table>
  <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
  ${footer ? `<tfoot><tr>${footer.map((c) => `<td>${esc(c)}</td>`).join('')}</tr></tfoot>` : ''}
</table>
</body></html>`;
}

export function formatMoneyCell(poisha) {
  return formatBDT(poisha);
}

export { diffDays };
