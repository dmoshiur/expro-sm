/** Dashboard + report endpoints. */
import type { Request, Response } from 'express';
import * as dashboardService from '../services/dashboard/dashboard.service';
import * as reportService from '../services/report/report.service';
import * as receiptService from '../services/receipt/receipt.service';
import { recordAudit } from '../services/audit/audit.service';
import { AuditAction, AuditEntity } from '../utils/auditActions';
import { fileNegotiation } from '../utils/download';
import { getClientIp, getUserAgent } from '../utils/http';
import { unauthorized } from '../utils/errors';

function actorOf(req: Request) {
  if (!req.admin) throw unauthorized();
  return { adminId: req.admin.id, ip: getClientIp(req), userAgent: getUserAgent(req) };
}

/** GET /api/dashboard */
export async function summary(req: Request, res: Response): Promise<void> {
  const months = Number((req.query as { months?: string }).months ?? 12);
  res.json(await dashboardService.getSummary(Number.isFinite(months) ? months : 12));
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

/** GET /api/reports/due */
export async function due(req: Request, res: Response): Promise<void> {
  res.json(await reportService.dueReport(req.query as never));
}

/** GET /api/reports/collections */
export async function collections(req: Request, res: Response): Promise<void> {
  res.json(await reportService.collectionReport(req.query as never));
}

/** GET /api/reports/investors/:id/statement */
export async function statement(req: Request, res: Response): Promise<void> {
  res.json(
    await reportService.investorStatement(
      (req.params as { id: string }).id,
      // role is only needed if we later mask mobile for VIEWER; kept for symmetry
    ),
  );
}

/**
 * GET /api/reports/due.xlsx | collections.xlsx | investors/:id/statement.xlsx
 * Exports are audited because they contain personal data.
 */
export async function exportDueXlsx(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const buffer = await reportService.exportDueWorkbook(req.query as never);
  await recordAudit(actor, { action: AuditAction.DATA_EXPORTED, entity: AuditEntity.REPORT, newValue: { report: 'due', format: 'xlsx' } });
  sendWorkbook(res, req, buffer, 'due-overdue-installments.xlsx');
}

export async function exportCollectionsXlsx(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const buffer = await reportService.exportCollectionsWorkbook(req.query as never);
  await recordAudit(actor, { action: AuditAction.DATA_EXPORTED, entity: AuditEntity.REPORT, newValue: { report: 'collections', format: 'xlsx' } });
  sendWorkbook(res, req, buffer, 'collection-register.xlsx');
}

export async function exportStatementXlsx(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const id = (req.params as { id: string }).id;
  const { buffer, name } = await reportService.exportStatementWorkbook(id);
  await recordAudit(actor, {
    action: AuditAction.DATA_EXPORTED,
    entity: AuditEntity.REPORT,
    newValue: { report: 'statement', investorId: id, format: 'xlsx' },
  });
  sendWorkbook(res, req, buffer, `statement-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx`);
}

/** GET /api/reports/investors/:id/statement.pdf */
export async function exportStatementPdf(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const id = (req.params as { id: string }).id;
  const statement = await reportService.investorStatement(id);

  const rows = [
    ...statement.investments.flatMap((investment) =>
      investment.installments.map((row) => ({
        date: new Date(row.dueDate).toISOString().slice(0, 10),
        description: `Installment due - investment ${investment.id.slice(0, 8)}`,
        reference: `${row.serial}/${investment.installmentCount} ${row.status}`,
        amount: BigInt(row.amount),
      })),
    ),
    ...statement.payments.map((payment) => ({
      date: payment.completedAt ? new Date(payment.completedAt).toISOString().slice(0, 10) : '',
      description: `Payment received (${payment.method})`,
      reference: payment.receiptNumber ?? payment.trxId ?? '',
      amount: BigInt(payment.amount),
    })),
  ];

  const doc = receiptService.generateStatementPdf({
    investorName: statement.investor.name,
    investorMobile: statement.investor.mobile,
    rows,
    totals: {
      contracted: BigInt(statement.totals.contracted),
      collected: BigInt(statement.totals.collected),
      outstanding: BigInt(statement.totals.outstanding),
    },
  });

  await recordAudit(actor, {
    action: AuditAction.DATA_EXPORTED,
    entity: AuditEntity.REPORT,
    newValue: { report: 'statement', investorId: id, format: 'pdf' },
  });

  const negotiation = fileNegotiation(req.headers.accept, 'statement.pdf');
  res.setHeader('Content-Type', negotiation.contentType);
  res.setHeader('Content-Disposition', negotiation.disposition);
  doc.pipe(res);
}

function sendWorkbook(res: Response, req: Request, buffer: Buffer, fileName: string): void {
  const negotiation = fileNegotiation(req.headers.accept, fileName, {
    forceAttachment: true,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  res.setHeader('Content-Type', negotiation.contentType);
  res.setHeader('Content-Disposition', negotiation.disposition);
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
}
