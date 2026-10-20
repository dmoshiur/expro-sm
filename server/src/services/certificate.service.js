/**
 * Printable membership certificate + full investment statement.
 *
 * Both are self-contained HTML documents with @media print rules: the browser's
 * "Print / Save as PDF" produces the PDF - no PDF library, no extra dependency,
 * exactly like receipts (see receipt.service.js).
 */
import { query } from '../db/client.js';
import { config } from '../config/index.js';
import { formatBDT } from '../utils/money.js';
import { dhakaDate, dhakaDateTimeString, isoDateOnly } from '../utils/dates.js';
import { maskMobile } from '../utils/mask.js';
import { memberCodeForId } from './investor-auth.service.js';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BRAND = '#047857';
const BRAND_DARK = '#064e3b';

export async function getCertificateData(investorId) {
  const investorRes = await query(
    `select i.id, i.name, i.name_bangla, i.member_code, i.mobile, i.father_name, i.present_address, i.permanent_address,
            i.created_at, i.status, i.membership_status, i.membership_decided_at, i.nid_last4
       from investors i where i.id = ?1 and i.deleted_at is null`,
    [investorId],
  );
  const investor = investorRes.rows[0];
  if (!investor) return null;

  const totalsRes = await query(
    `select coalesce(sum(inst.amount_paid), 0) as total_paid,
            coalesce(sum(case when inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE') then inst.amount - inst.amount_paid else 0 end), 0) as outstanding,
            coalesce(sum(case when inst.status = 'PAID' then 1 else 0 end), 0) as paid_installments,
            count(inst.id) as total_installments
       from installments inst join investments v on v.id = inst.investment_id
      where v.investor_id = ?1 and v.status <> 'CANCELLED' and inst.status <> 'CANCELLED'`,
    [investorId],
  );
  const investedRes = await query(
    `select coalesce(sum(total_amount), 0) as total_invested, count(*) as investments
       from investments where investor_id = ?1 and status <> 'CANCELLED'`,
    [investorId],
  );
  const nominees = await query(
    'select name, relation, share_percent from nominees where investor_id = ?1 order by share_percent desc, id asc',
    [investorId],
  );

  return {
    investor: {
      ...investor,
      member_code: investor.member_code ?? memberCodeForId(investor.id),
      mobile_masked: maskMobile(investor.mobile),
    },
    totals: {
      total_paid: Number(totalsRes.rows[0]?.total_paid ?? 0),
      outstanding: Number(totalsRes.rows[0]?.outstanding ?? 0),
      paid_installments: Number(totalsRes.rows[0]?.paid_installments ?? 0),
      total_installments: Number(totalsRes.rows[0]?.total_installments ?? 0),
      total_invested: Number(investedRes.rows[0]?.total_invested ?? 0),
      investments: Number(investedRes.rows[0]?.investments ?? 0),
    },
    nominees: nominees.rows,
    business: { name: config.totp.issuer, baseUrl: config.publicBaseUrl },
    issuedOn: dhakaDate(),
    certificateNo: `MEM-${String(investor.id).padStart(6, '0')}`,
  };
}

const PRINT_STYLES = `
  :root { color-scheme: light; --brand: ${BRAND}; --brand-dark: ${BRAND_DARK}; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 28px; color: var(--ink); background: #f8fafc; }
  .sheet { max-width: 900px; margin: 0 auto; background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 34px; box-shadow: 0 1px 2px rgba(15,23,42,.06); }
  .actions { max-width: 900px; margin: 0 auto 14px; display: flex; gap: 10px; justify-content: flex-end; }
  button, .btn { font: inherit; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; text-decoration: none; }
  h1 { font-size: 21px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: var(--brand-dark); }
  .muted { color: var(--muted); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 7px; border-bottom: 1px solid var(--line); }
  th { color: #475569; font-weight: 600; background: #f8fafc; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0; }
  .stat { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .stat .value { font-size: 16px; font-weight: 700; margin-top: 3px; }
  .head { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; border-bottom: 2px solid var(--brand); padding-bottom: 14px; }
  .foot { margin-top: 26px; font-size: 11px; color: var(--muted); line-height: 1.6; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { border: 0; box-shadow: none; border-radius: 0; max-width: none; padding: 8mm; }
    .actions { display: none; }
  }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } .sheet { padding: 20px; } }
`;

/** Landscape A4 membership certificate. */
export function renderCertificateHtml(data, { autoPrint = false } = {}) {
  const { investor, totals, nominees, business } = data;
  const approved = investor.membership_status === 'APPROVED';
  const shareLines = nominees.length
    ? nominees.map((n) => `${esc(n.name)} (${esc(n.relation)}) - ${Number(n.share_percent)}%`).join(' &nbsp;·&nbsp; ')
    : 'No nominee recorded';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Membership certificate - ${esc(investor.name)}</title>
<style>
  ${PRINT_STYLES}
  @page { size: A4 landscape; margin: 10mm; }
  .certificate { border: 3px double ${BRAND}; border-radius: 14px; padding: 34px 44px; position: relative; overflow: hidden; }
  .certificate::before { content: ""; position: absolute; inset: 8px; border: 1px solid rgba(4,120,87,.25); border-radius: 10px; pointer-events: none; }
  .cert-head { text-align: center; }
  .logo { width: 52px; height: 52px; border-radius: 14px; margin: 0 auto 10px; background: linear-gradient(135deg, ${BRAND}, ${BRAND_DARK}); color: #fff; display: grid; place-items: center; font-weight: 800; font-size: 18px; letter-spacing: .04em; }
  .cert-title { font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: ${BRAND}; font-weight: 700; }
  .name { font-size: 33px; font-weight: 800; margin: 16px 0 2px; color: var(--brand-dark); }
  .bangla { font-size: 19px; color: #334155; margin-bottom: 8px; }
  .cert-text { font-size: 14px; line-height: 1.8; color: #334155; max-width: 660px; margin: 10px auto 0; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0 10px; text-align: left; }
  .meta .stat { background: #f0fdf4; border-color: #bbf7d0; }
  .sign-row { display: flex; justify-content: space-between; gap: 30px; margin-top: 36px; align-items: flex-end; }
  .sign-line { flex: 1; border-top: 1px solid #94a3b8; padding-top: 6px; font-size: 11px; color: var(--muted); text-align: center; }
  .seal { width: 92px; height: 92px; border-radius: 50%; border: 2px dashed ${BRAND}; color: ${BRAND}; display: grid; place-items: center; text-align: center; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 10px; }
  .status { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .05em; background: ${approved ? '#dcfce7' : '#fee2e2'}; color: ${approved ? BRAND_DARK : '#b91c1c'}; }
</style></head>
<body>
  <div class="actions">
    <a class="btn" href="${esc(business.baseUrl)}">Back to portal</a>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="sheet">
    <div class="certificate">
      <div class="cert-head">
        <div class="logo">${esc(business.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || 'MEM')}</div>
        <div class="cert-title">Certificate of membership</div>
        <div class="muted">${esc(business.name)}</div>
      </div>
      <div style="text-align:center">
        <div class="name">${esc(investor.name)}</div>
        ${investor.name_bangla ? `<div class="bangla">${esc(investor.name_bangla)}</div>` : ''}
        <div class="cert-text">
          This certificate confirms that <strong>${esc(investor.name)}</strong>
          ${investor.father_name ? `, child of ${esc(investor.father_name)},` : ''}
          member code <strong>${esc(investor.member_code)}</strong>, is a registered member of
          ${esc(business.name)} since ${esc(isoDateOnly(investor.created_at))}. The member has recorded
          ${formatBDT(totals.total_paid)} across ${totals.paid_installments} of ${totals.total_installments}
          pension installments.
        </div>
      </div>
      <div class="meta">
        <div class="stat"><div class="label">Member code</div><div class="value">${esc(investor.member_code)}</div></div>
        <div class="stat"><div class="label">Total invested</div><div class="value">${formatBDT(totals.total_invested)}</div></div>
        <div class="stat"><div class="label">Collected</div><div class="value">${formatBDT(totals.total_paid)}</div></div>
        <div class="stat"><div class="label">Outstanding</div><div class="value">${formatBDT(totals.outstanding)}</div></div>
      </div>
      <div class="small" style="font-size:12px;color:#475569">
        Nominees on record: ${shareLines}
      </div>
      <div class="sign-row">
        <div class="sign-line">Member signature</div>
        <div class="seal">${approved ? 'Approved member' : 'Pending approval'}<br>${esc(data.certificateNo)}</div>
        <div class="sign-line">Authorised signatory</div>
      </div>
      <div class="foot" style="text-align:center;margin-top:18px">
        Certificate ${esc(data.certificateNo)} · issued ${esc(data.issuedOn)} (Asia/Dhaka) ·
        <span class="status">${esc(investor.membership_status)}</span>
        <br>Verify this certificate with the member code at ${esc(business.baseUrl)}.
      </div>
    </div>
  </div>
  ${autoPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
</body></html>`;
}

/** Full investment / pension statement (schedule + payments + wallet + nominees). */
export function renderStatementHtml(statement, { wallet = null, business = null, autoPrint = false } = {}) {
  const { investor, investments, payments, schedule, totals } = statement;
  const summary = [
    ['Total invested', formatBDT(totals.invested)],
    ['Collected', formatBDT(totals.collected)],
    ['Outstanding', formatBDT(totals.outstanding)],
    ['Wallet balance', wallet ? formatBDT(wallet.balance) : '—'],
  ];
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Investment statement - ${esc(investor.name)}</title>
<style>${PRINT_STYLES}</style>
</head><body>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="head">
      <div>
        <h1>${esc(business?.name ?? config.totp.issuer)}</h1>
        <div class="muted">Investment &amp; pension statement</div>
      </div>
      <div class="muted" style="text-align:right">
        Generated ${esc(dhakaDateTimeString())}<br>Member ${esc(investor.id)}
      </div>
    </div>
    <h2>${esc(investor.name)} <span class="muted">· ${esc(maskMobile(investor.mobile))}</span></h2>
    <div class="muted">Member since ${esc(isoDateOnly(investor.created_at))} · Status ${esc(investor.status)}</div>

    <div class="grid">
      ${summary.map(([label, value]) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join('')}
    </div>

    <h2>Pension enrollments</h2>
    <table>
      <thead><tr><th>#</th><th>Title</th><th class="num">Total</th><th class="num">Installments</th><th class="num">Collected</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
      <tbody>
        ${investments.length ? investments.map((row) => `<tr><td>#${esc(row.id)}</td><td>${esc(row.title ?? 'Pension plan')}</td><td class="num">${formatBDT(row.total_amount)}</td><td class="num">${esc(row.installment_count)}</td><td class="num">${formatBDT(row.collected)}</td><td class="num">${formatBDT(row.outstanding)}</td><td>${esc(row.status)}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No enrollments yet.</td></tr>'}
      </tbody>
    </table>

    <h2>Installment schedule</h2>
    <table>
      <thead><tr><th>#</th><th>Installment</th><th>Due date</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
      <tbody>
        ${schedule.length ? schedule.map((row) => `<tr><td>${esc(row.investment_id)}</td><td>#${esc(row.serial)}</td><td>${esc(isoDateOnly(row.due_date))}</td><td class="num">${formatBDT(row.amount)}</td><td class="num">${formatBDT(row.amount_paid)}</td><td class="num">${formatBDT(row.outstanding)}</td><td>${esc(row.status)}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No installments yet.</td></tr>'}
      </tbody>
    </table>

    <h2>Payments</h2>
    <table>
      <thead><tr><th>Receipt</th><th>Date</th><th>Installment</th><th class="num">Amount</th><th>Method</th><th>Trx / Ref</th><th>Status</th></tr></thead>
      <tbody>
        ${payments.length ? payments.map((row) => `<tr><td>PAY-${esc(row.id)}</td><td>${esc(isoDateOnly(row.paid_at ?? row.created_at))}</td><td>#${esc(row.installment_serial)}</td><td class="num">${formatBDT(row.amount)}</td><td>${esc(row.method)}</td><td>${esc(row.trx_id ?? row.manual_reference ?? '—')}</td><td>${esc(row.status)}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No payments recorded yet.</td></tr>'}
      </tbody>
    </table>

    ${wallet ? `<h2>Wallet ledger</h2>
    <div class="grid">
      <div class="stat"><div class="label">Balance</div><div class="value">${formatBDT(wallet.balance)}</div></div>
      <div class="stat"><div class="label">Deposited</div><div class="value">${formatBDT(wallet.total_deposited)}</div></div>
      <div class="stat"><div class="label">Withdrawn</div><div class="value">${formatBDT(wallet.total_withdrawn)}</div></div>
      <div class="stat"><div class="label">Earned</div><div class="value">${formatBDT(wallet.total_earned)}</div></div>
    </div>` : ''}

    <div class="foot">
      This statement is generated from the live ledger of ${esc(business?.name ?? config.totp.issuer)}. Amounts are in
      Bangladeshi Taka. bKash payments are recorded only after server-side verification; manual payments carry an
      office reference. For questions open a support inquiry in the portal.
    </div>
  </div>
  ${autoPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
</body></html>`;
}
