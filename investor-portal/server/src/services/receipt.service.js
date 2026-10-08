/**
 * Receipts: deterministic receipt numbers + a self-contained printable HTML
 * document (print-to-PDF via the browser, @media print CSS, no library).
 */
import { config } from '../config/index.js';
import { formatBDT } from '../utils/money.js';
import { dhakaDateTimeString, isoDateOnly } from '../utils/dates.js';
import { maskMobile } from '../utils/mask.js';
import { getPayment } from './payment.service.js';

/** RCPT-<year>-<payment id padded> - stable because payment rows are immutable-ish. */
export function receiptNumber(payment) {
  const year = new Date(payment.paid_at ?? payment.created_at ?? Date.now()).getUTCFullYear() + (0);
  return `RCPT-${year}-${String(payment.id).padStart(6, '0')}`;
}

export async function getReceiptData(paymentId) {
  const payment = await getPayment(paymentId);
  return {
    receiptNumber: receiptNumber(payment),
    issuedAt: payment.paid_at ?? payment.created_at,
    status: payment.status,
    amount: Number(payment.amount),
    method: payment.method,
    gateway: payment.gateway,
    trxId: payment.trx_id,
    manualReference: payment.manual_reference,
    referenceNote: payment.reference_note,
    investor: {
      id: payment.investor_id,
      name: payment.investor_name,
      mobileMasked: maskMobile(payment.investor_mobile),
    },
    investment: {
      id: payment.investment_id,
      totalAmount: Number(payment.investment_total),
    },
    installment: {
      id: payment.id ? undefined : null,
      serial: payment.installment_serial,
      amount: Number(payment.installment_amount),
      amountPaid: Number(payment.installment_amount_paid),
      dueDate: isoDateOnly(payment.due_date),
      status: payment.installment_status,
    },
    recordedBy: payment.recorded_by_name ?? null,
    business: { name: config.totp.issuer, baseUrl: config.publicBaseUrl },
  };
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderReceiptHtml(data, { autoPrint = false } = {}) {
  const rows = [
    ['Receipt number', data.receiptNumber],
    ['Date', dhakaDateTimeString(new Date(data.issuedAt))],
    ['Investor', data.investor.name],
    ['Mobile', data.investor.mobileMasked],
    ['Investment', `#${data.investment.id} (total ${formatBDT(data.investment.totalAmount)})`],
    ['Installment', `#${data.installment.serial} (due ${esc(data.installment.dueDate)})`],
    ['Payment method', data.method === 'BKASH' ? 'bKash' : data.method],
    ['Transaction ID', data.trxId ?? '—'],
    ['Manual reference', data.manualReference ?? '—'],
    ['Recorded by', data.recordedBy ?? 'System (gateway verified)'],
    ['Status', data.status],
  ];
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.receiptNumber)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px; color: #14213d; background: #f6f7fb; }
  .sheet { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e2e6ef; border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: #64748b; font-size: 13px; }
  .head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 2px solid #14213d; padding-bottom: 16px; margin-bottom: 20px; }
  .amount { font-size: 28px; font-weight: 700; margin: 16px 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
  th { width: 42%; color: #475569; font-weight: 600; }
  .stamp { display:inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .04em; background: #e7f6ee; color: #0f7a4a; }
  .stamp.failed { background:#fdecec; color:#b42318; }
  .foot { margin-top: 28px; font-size: 12px; color: #64748b; line-height: 1.6; }
  .actions { max-width: 720px; margin: 16px auto 0; display: flex; gap: 12px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #14213d; background: #14213d; color: #fff; cursor: pointer; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { border: 0; border-radius: 0; padding: 0 4mm; max-width: none; }
    .actions { display: none; }
    a { color: inherit; text-decoration: none; }
  }
</style></head>
<body>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="head">
      <div>
        <h1>${esc(data.business.name)}</h1>
        <div class="muted">Payment receipt</div>
      </div>
      <div style="text-align:right">
        <div class="stamp ${data.status === 'SUCCESS' ? '' : 'failed'}">${esc(data.status)}</div>
        <div class="muted" style="margin-top:6px">${esc(data.receiptNumber)}</div>
      </div>
    </div>
    <div class="muted">Amount received</div>
    <div class="amount">${formatBDT(data.amount)}</div>
    <div class="muted">Received from ${esc(data.investor.name)} (${esc(data.investor.mobileMasked)})</div>
    <table>
      ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n      ')}
    </table>
    <div class="foot">
      This receipt was generated by the ${esc(data.business.name)} system and reflects the payment recorded against
      installment #${esc(data.installment.serial)} of investment #${esc(data.investment.id)}.
      bKash payments are marked PAID only after the server verifies the transaction with the gateway.
      Generated at ${esc(dhakaDateTimeString())} (Asia/Dhaka).
    </div>
  </div>
  ${autoPrint ? '<script>window.addEventListener("load",()=>window.print());</script>' : ''}
</body></html>`;
}
