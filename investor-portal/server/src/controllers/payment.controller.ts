/** Admin payment endpoints: manual entry, listing, receipts. */
import type { Request, Response } from 'express';
import * as paymentService from '../services/payment/payment.service';
import type { PaymentActor } from '../services/payment/payment.service';
import { receiptService } from '../services/receipt/receipt.service';
import { recordAudit } from '../services/audit/audit.service';
import { AuditAction, AuditEntity } from '../utils/auditActions';
import { fileNegotiation } from '../utils/download';
import { unauthorized } from '../utils/errors';
import { getClientIp, getUserAgent } from '../utils/http';
import { serializeMoney } from '../utils/money';

export function actorOf(req: Request): PaymentActor {
  if (!req.admin) throw unauthorized();
  return { adminId: req.admin.id, ip: getClientIp(req), userAgent: getUserAgent(req) };
}

/** POST /api/payments/installments/:id/manual */
export async function recordManual(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const body = req.body as {
    amount?: string;
    method: 'CASH' | 'BANK' | 'OTHER';
    reference: string;
    note?: string;
    paidAt?: string;
  };
  const result = await paymentService.recordManualPayment((req.params as { id: string }).id, body, actor);
  res.status(201).json(result);
}

/** GET /api/payments */
export async function list(req: Request, res: Response): Promise<void> {
  const result = await paymentService.listPayments(req.query as never);
  res.json(result);
}

/** GET /api/payments/:id */
export async function detail(req: Request, res: Response): Promise<void> {
  const payment = await paymentService.getPaymentById((req.params as { id: string }).id);
  res.json({ payment: serializeMoney({ ...paymentService.serializePayment(payment) }) });
}

/**
 * GET /api/payments/:id/receipt.pdf
 * Streams the PDF and audits the download (receipts contain personal data).
 */
export async function downloadReceipt(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const payment = await paymentService.getPaymentById((req.params as { id: string }).id);

  if (payment.status !== 'SUCCESS') {
    const { conflict } = await import('../utils/errors');
    throw conflict('Only successful payments have a receipt');
  }

  const doc = receiptService.generatePaymentReceipt({
    payment,
    installment: payment.installment,
    investment: payment.installment.investment,
    investor: payment.installment.investment.investor,
  });

  await recordAudit(actor, {
    action: AuditAction.RECEIPT_DOWNLOADED,
    entity: AuditEntity.PAYMENT,
    entityId: payment.id,
    newValue: { receiptNumber: payment.receiptNumber },
  });

  const fileName = `receipt-${payment.receiptNumber ?? payment.id.slice(0, 8)}.pdf`;
  const negotiation = fileNegotiation(req.headers.accept, fileName);
  res.setHeader('Content-Type', negotiation.contentType);
  res.setHeader('Content-Disposition', `${negotiation.disposition}`);
  doc.pipe(res);
}
