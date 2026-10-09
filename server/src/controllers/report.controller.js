import { ok, csv, html } from '../utils/http.js';
import { badRequest, notFound } from '../utils/errors.js';
import { parsePagination, paged } from '../utils/pagination.js';
import { formatBDT } from '../utils/money.js';
import { dhakaDate, isoDateOnly } from '../utils/dates.js';
import * as reportService from '../services/report.service.js';
import * as investorService from '../services/investor.service.js';
import * as paymentService from '../services/payment.service.js';
import * as audit from '../services/audit.service.js';

function recordExport(action, entity, req, rows) {
  return audit.record({
    action: audit.AUDIT_ACTIONS.REPORT_EXPORTED,
    entity: 'report',
    entityId: entity,
    meta: { rows, action },
    actor: req.admin,
    req,
  });
}

export async function collections(req, res) {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  const data = await reportService.collectionByMonth({ months });
  return ok(res, data);
}

export async function collectionsCsvExport(req, res) {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  const data = await reportService.collectionByMonth({ months });
  const { content, filename } = reportService.collectionsCsv(data);
  await recordExport('COLLECTIONS_CSV', filename, req, data.months.length);
  return csv(res, content, filename);
}

export async function due(req, res) {
  const data = await reportService.dueReport({
    from: req.query.from,
    to: req.query.to,
    status: req.query.status,
    investorId: req.query.investorId ? Number(req.query.investorId) : null,
  });
  return ok(res, data);
}

export async function dueCsv(req, res) {
  const data = await reportService.dueReport({ from: req.query.from, to: req.query.to, status: req.query.status });
  const { content, filename } = reportService.dueReportCsv(data);
  await recordExport('DUE_CSV', filename, req, data.rows.length);
  return csv(res, content, filename);
}

export async function overdue(req, res) {
  const data = await reportService.overdueReport({ asOf: req.query.asOf });
  return ok(res, data);
}

export async function overdueCsv(req, res) {
  const data = await reportService.overdueReport({ asOf: req.query.asOf });
  const { content, filename } = reportService.overdueReportCsv(data);
  await recordExport('OVERDUE_CSV', filename, req, data.rows.length);
  return csv(res, content, filename);
}

export async function statement(req, res) {
  const investorId = Number(req.params.investorId);
  const data = await reportService.investorStatement({ investorId, from: req.query.from, to: req.query.to });
  if (!data) throw notFound('Investor not found');
  return ok(res, data);
}

export async function statementCsvExport(req, res) {
  const investorId = Number(req.params.investorId);
  const data = await reportService.investorStatement({ investorId, from: req.query.from, to: req.query.to });
  if (!data) throw notFound('Investor not found');
  const { content, filename } = reportService.statementCsv(data);
  await recordExport('STATEMENT_CSV', filename, req, data.payments.length);
  return csv(res, content, filename);
}

export async function investorsCsvExport(req, res) {
  const { limit, offset } = parsePagination({ ...req.query, limit: 100 }, { defaultLimit: 100, maxLimit: 100 });
  const result = await investorService.listInvestors({
    search: req.query.search,
    status: req.query.status,
    limit,
    offset,
    sort: req.query.sort,
    dir: req.query.dir,
  });
  const { content, filename } = reportService.investorsCsv(result);
  await recordExport('INVESTORS_CSV', filename, req, result.rows.length);
  return csv(res, content, filename);
}

// --- printable HTML reports ------------------------------------------------
export async function duePrint(req, res) {
  const data = await reportService.dueReport({ from: req.query.from, to: req.query.to });
  const markup = reportService.renderReportHtml({
    title: 'Installments due',
    subtitle: `${data.rows.length} installment(s) - outstanding ${formatBDT(data.summary.outstanding)}`,
    columns: ['Investor', 'Mobile', 'Investment', 'Installment', 'Outstanding', 'Due date', 'Status', 'Days'],
    rows: data.rows.map((r) => [
      r.investor_name,
      r.investor_mobile,
      `#${r.investment_id}`,
      `#${r.serial}`,
      formatBDT(r.outstanding),
      isoDateOnly(r.due_date),
      r.status,
      r.days_from_today,
    ]),
    footer: ['Total', '', '', '', formatBDT(data.summary.outstanding), '', '', ''],
  });
  return html(res, markup, { filename: 'due-report.html' });
}

export async function overduePrint(req, res) {
  const data = await reportService.overdueReport({ asOf: req.query.asOf });
  const markup = reportService.renderReportHtml({
    title: 'Overdue installments',
    subtitle: `as of ${data.summary.asOf} - ${data.summary.count} item(s), outstanding ${formatBDT(data.summary.outstanding)}`,
    columns: ['Investor', 'Mobile', 'Investment', 'Installment', 'Outstanding', 'Due date', 'Days late', 'Status'],
    rows: data.rows.map((r) => [
      r.investor_name,
      r.investor_mobile,
      `#${r.investment_id}`,
      `#${r.serial}`,
      formatBDT(r.outstanding),
      isoDateOnly(r.due_date),
      r.days_overdue,
      r.status,
    ]),
    footer: ['Total', '', '', '', formatBDT(data.summary.outstanding), '', '', ''],
  });
  return html(res, markup, { filename: 'overdue-report.html' });
}

export async function statementPrint(req, res) {
  const investorId = Number(req.params.investorId);
  const data = await reportService.investorStatement({ investorId });
  if (!data) throw notFound('Investor not found');
  const rows = [];
  for (const inv of data.investments) {
    rows.push(['Investment', `#${inv.id}`, `total ${formatBDT(inv.total_amount)}`, inv.status, '', `collected ${formatBDT(inv.collected)}, outstanding ${formatBDT(inv.outstanding)}`]);
  }
  for (const p of data.payments) {
    rows.push(['Payment', `PAY-${p.id}`, formatBDT(p.amount), p.status, p.paid_at ? isoDateOnly(p.paid_at) : '', `${p.method}${p.trx_id ? ` trx ${p.trx_id}` : ''}`]);
  }
  for (const s of data.schedule.filter((x) => ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(x.status))) {
    rows.push(['Due', `INST-${s.id}`, formatBDT(s.outstanding), s.status, isoDateOnly(s.due_date), `installment #${s.serial}`]);
  }
  const markup = reportService.renderReportHtml({
    title: `Investor statement - ${data.investor.name}`,
    subtitle: `mobile ${data.investor.mobile_masked} - invested ${formatBDT(data.totals.invested)}, collected ${formatBDT(data.totals.collected)}, outstanding ${formatBDT(data.totals.outstanding)}`,
    columns: ['Kind', 'Reference', 'Amount', 'Status', 'Date', 'Detail'],
    rows,
    footer: ['', '', formatBDT(data.totals.outstanding), '', '', 'outstanding'],
  });
  return html(res, markup, { filename: `statement-${investorId}.html` });
}

export async function paymentsPrint(req, res) {
  const { limit, offset } = parsePagination({ ...req.query, limit: 200 }, { defaultLimit: 200, maxLimit: 200 });
  const result = await paymentService.listPayments({
    status: req.query.status ? String(req.query.status).split(',') : undefined,
    method: req.query.method,
    paidFrom: req.query.paidFrom,
    paidTo: req.query.paidTo,
    limit,
    offset,
  });
  const markup = reportService.renderReportHtml({
    title: 'Payment ledger',
    subtitle: `${result.rows.length} payment(s) - successful total ${formatBDT(result.successAmount)}`,
    columns: ['#', 'Investor', 'Installment', 'Amount', 'Method', 'Status', 'Trx / Ref', 'Paid at'],
    rows: result.rows.map((p) => [
      p.id,
      p.investor_name,
      `#${p.installment_serial}`,
      formatBDT(p.amount),
      p.method,
      p.status,
      p.trx_id ?? p.manual_reference ?? '',
      p.paid_at ? String(p.paid_at).slice(0, 19).replace('T', ' ') : '',
    ]),
  });
  return html(res, markup, { filename: 'payments.html' });
}

export async function today(req, res) {
  const data = await reportService.dashboard({});
  return ok(res, {
    date: dhakaDate(),
    todayCollection: data.kpis.todayCollection,
    todayPaymentCount: data.kpis.todayPaymentCount,
    overdueAmount: data.kpis.overdueAmount,
    overdueCount: data.kpis.overdueCount,
    upcomingDueAmount: data.kpis.upcomingDueAmount,
  });
}

export function ensureRange(req) {
  if (req.query.from && req.query.to && req.query.from > req.query.to) throw badRequest('`from` must be before `to`');
  return true;
}

export { paged };
