/**
 * PDF receipts (pdfkit) and Excel/PDF report primitives shared with the reports
 * module.
 *
 * Layout is intentionally simple and print friendly: A5-ish width, company
 * header, receipt meta (number, date, gateway, trx id), investor and
 * installment blocks, total in words, and a signature line.
 */
import PDFDocument from 'pdfkit';
import type { Payment, Installment, Investment, Investor } from '../../generated/prisma/client';
import { formatBdt } from '../../utils/money';
import { formatDhakaDate, formatDhakaDateTime } from '../../utils/dates';
import { maskMobile } from '../../utils/encryption';

export interface ReceiptData {
  payment: Payment;
  installment: Installment;
  investment: Investment;
  investor: Investor;
}

const COMPANY_NAME = process.env.COMPANY_NAME ?? 'Investor Installment Portal';
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS ?? 'Dhaka, Bangladesh';
const COMPANY_MOBILE = process.env.COMPANY_MOBILE ?? '';

const numberToWords = (value: number): string => {
  if (value === 0) return 'zero';
  const units = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const chunk = (num: number): string => {
    if (num < 20) return units[num] ?? '';
    if (num < 100) return `${tens[Math.floor(num / 10)]}${num % 10 ? ` ${units[num % 10]}` : ''}`;
    if (num < 1000) return `${units[Math.floor(num / 100)]} hundred${num % 100 ? ` ${chunk(num % 100)}` : ''}`;
    if (num < 100_000) return `${chunk(Math.floor(num / 1000))} thousand${num % 1000 ? ` ${chunk(num % 1000)}` : ''}`;
    if (num < 10_000_000) return `${chunk(Math.floor(num / 100_000))} lakh${num % 100_000 ? ` ${chunk(num % 100_000)}` : ''}`;
    return `${chunk(Math.floor(num / 10_000_000))} crore${num % 10_000_000 ? ` ${chunk(num % 10_000_000)}` : ''}`;
  };
  return chunk(Math.floor(value));
};

export function amountInWords(poisha: bigint): string {
  const taka = Number(poisha / 100n);
  const paisa = Number(poisha % 100n);
  return `${numberToWords(taka)} taka${paisa > 0 ? ` and ${numberToWords(paisa)} paisa` : ''} only`;
}

function header(doc: PDFKit.PDFDocument, title: string): void {
  doc
    .fillColor('#0f172a')
    .fontSize(16)
    .font('Helvetica-Bold')
    .text(COMPANY_NAME, { align: 'left' })
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#475569')
    .text(COMPANY_ADDRESS)
    .text(COMPANY_MOBILE ? `Mobile: ${COMPANY_MOBILE}` : '')
    .moveDown(0.4)
    .fillColor('#0f172a')
    .fontSize(13)
    .font('Helvetica-Bold')
    .text(title, { align: 'right' })
    .moveDown(0.6);

  doc
    .strokeColor('#cbd5f5')
    .lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke()
    .moveDown(0.8);
}

function row(doc: PDFKit.PDFDocument, label: string, value: string, options: { bold?: boolean } = {}): void {
  const startY = doc.y;
  doc.fontSize(9.5).fillColor('#64748b').font('Helvetica').text(label, doc.page.margins.left, startY, { width: 170 });
  doc
    .fontSize(9.5)
    .fillColor('#0f172a')
    .font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
    .text(value, doc.page.margins.left + 175, startY, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 175 });
  doc.moveDown(0.35);
}

function footer(doc: PDFKit.PDFDocument, note: string): void {
  const bottom = doc.page.height - doc.page.margins.bottom - 40;
  doc
    .fontSize(8)
    .fillColor('#94a3b8')
    .font('Helvetica')
    .text(note, doc.page.margins.left, bottom, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right })
    .text(
      'This is a computer generated document from the Investor Installment Portal.',
      doc.page.margins.left,
      bottom + 12,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
    );
}

/** Streams a payment receipt as a PDF. */
export function generatePaymentReceipt(data: ReceiptData): PDFKit.PDFDocument {
  const { payment, installment, investment, investor } = data;
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Receipt ${payment.receiptNumber ?? payment.id}` } });

  header(doc, 'PAYMENT RECEIPT');

  row(doc, 'Receipt number', payment.receiptNumber ?? '—', { bold: true });
  row(doc, 'Receipt date', formatDhakaDateTime(payment.completedAt ?? payment.createdAt));
  row(doc, 'Payment method', payment.method === 'BKASH' ? 'bKash (online)' : payment.method);
  row(doc, 'Gateway', payment.gateway);
  if (payment.trxId) row(doc, 'Transaction ID', payment.trxId);
  if (payment.gatewayPaymentId) row(doc, 'Gateway payment ID', payment.gatewayPaymentId);
  if (payment.manualReference) row(doc, 'Reference', payment.manualReference);
  if (payment.recordedByAdminId) row(doc, 'Recorded by', `Admin ${payment.recordedByAdminId.slice(0, 8)}`);

  doc.moveDown(0.6);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a').text('Investor').moveDown(0.3);
  row(doc, 'Name', investor.name);
  row(doc, 'Mobile', maskMobile(investor.mobile));
  if (investor.address) row(doc, 'Address', investor.address);

  doc.moveDown(0.6);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a').text('Installment').moveDown(0.3);
  row(doc, 'Investment ID', investment.id);
  row(doc, 'Installment', `${installment.serial} of ${investment.installmentCount}`);
  row(doc, 'Due date', formatDhakaDate(installment.dueDate));
  row(doc, 'Installment amount', `BDT ${formatBdt(installment.amount).replace('৳ ', '')}`);
  row(doc, 'Paid so far', `BDT ${formatBdt(installment.paidAmount).replace('৳ ', '')}`);
  row(doc, 'Installment status', installment.status);

  doc.moveDown(0.8);
  const boxTop = doc.y;
  const boxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.rect(doc.page.margins.left, boxTop, boxWidth, 54).fillAndStroke('#f1f5ff', '#c7d2fe');
  doc
    .fillColor('#1e293b')
    .fontSize(10)
    .font('Helvetica-Bold')
    .text('Amount received', doc.page.margins.left + 12, boxTop + 10)
    .fontSize(15)
    .text(`BDT ${formatBdt(payment.amount).replace('৳ ', '')}`, doc.page.margins.left + 12, boxTop + 24);
  doc.fontSize(8.5).font('Helvetica').fillColor('#475569').text(`In words: ${amountInWords(payment.amount)}`, doc.page.margins.left + 12, boxTop + 44, { width: boxWidth - 24 });

  doc.y = boxTop + 74;
  doc.fontSize(9).fillColor('#334155').text('Received by', doc.page.margins.left, doc.y);
  doc.moveDown(2.2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 180, doc.y).strokeColor('#94a3b8').stroke();
  doc.fontSize(8).fillColor('#64748b').text('Authorised signature', doc.page.margins.left, doc.y + 3);

  footer(doc, `Payment status: ${payment.status}. Keep this receipt for your records.`);
  doc.end();
  return doc;
}

/** Investor statement cover page + payment table (used by the reports module). */
export interface StatementRow {
  date: string;
  description: string;
  reference: string;
  amount: bigint;
}

export function generateStatementPdf(params: {
  investorName: string;
  investorMobile: string;
  rows: StatementRow[];
  totals: { collected: bigint; contracted: bigint; outstanding: bigint };
}): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Statement - ${params.investorName}` } });
  header(doc, 'INVESTOR STATEMENT');

  row(doc, 'Investor', params.investorName);
  row(doc, 'Mobile', maskMobile(params.investorMobile));
  row(doc, 'Generated at', formatDhakaDateTime(new Date()));

  doc.moveDown(0.8);
  const x0 = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#0f172a');
  doc.text('Date', x0, doc.y, { width: 90, continued: false });
  const headerY = doc.y;
  doc.text('Description', x0 + 95, headerY - 11, { width: 230 });
  doc.text('Reference', x0 + 330, headerY - 11, { width: 120 });
  doc.text('Amount (BDT)', x0 + 450, headerY - 11, { width: width - 450, align: 'right' });
  doc.moveDown(0.4);
  doc.strokeColor('#e2e8f0').moveTo(x0, doc.y).lineTo(x0 + width, doc.y).stroke().moveDown(0.4);

  doc.font('Helvetica').fontSize(8.5).fillColor('#1e293b');
  for (const item of params.rows) {
    const y = doc.y;
    if (y > doc.page.height - doc.page.margins.bottom - 120) {
      doc.addPage();
    }
    const currentY = doc.y;
    doc.text(item.date, x0, currentY, { width: 90 });
    doc.text(item.description.slice(0, 90), x0 + 95, currentY, { width: 230 });
    doc.text(item.reference.slice(0, 40), x0 + 330, currentY, { width: 120 });
    doc.text(formatBdt(item.amount).replace('৳ ', ''), x0 + 450, currentY, { width: width - 450, align: 'right' });
    doc.moveDown(0.45);
  }

  doc.moveDown(0.8);
  doc.strokeColor('#cbd5f5').moveTo(x0, doc.y).lineTo(x0 + width, doc.y).stroke().moveDown(0.6);
  row(doc, 'Total contracted', `BDT ${formatBdt(params.totals.contracted).replace('৳ ', '')}`, { bold: true });
  row(doc, 'Total collected', `BDT ${formatBdt(params.totals.collected).replace('৳ ', '')}`, { bold: true });
  row(doc, 'Outstanding', `BDT ${formatBdt(params.totals.outstanding).replace('৳ ', '')}`, { bold: true });

  footer(doc, 'Statement generated from the Investor Installment Portal.');
  doc.end();
  return doc;
}

/** Converts a PDFDocument stream into a Buffer (for storage / tests). */
export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export const receiptService = { generatePaymentReceipt, generateStatementPdf, amountInWords, pdfToBuffer };
export default receiptService;
export type { Payment, Installment, Investment, Investor };
