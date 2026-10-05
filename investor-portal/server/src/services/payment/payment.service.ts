/**
 * Payment service - the heart of the money flow.
 *
 * Flow (bKash Tokenized Checkout):
 *   1. investor opens /pay/:token and presses "Pay with bKash"
 *   2. startPayment() creates a Payment row (INITIATED) and asks the gateway for
 *      a paymentID + redirect URL; the payer is redirected
 *   3. the gateway sends the investor back to /api/public/payments/bkash/callback
 *   4. handleGatewayCallback() *never* trusts the query string: it looks the
 *      payment up by our own paymentID, then asks the gateway to execute and
 *      query the transaction
 *   5. verifyTransaction() checks amount, currency-level status and the merchant
 *      invoice number
 *   6. settlePayment() flips Payment -> SUCCESS and Installment -> PAID in ONE
 *      database transaction (idempotent: a repeated callback is a no-op)
 *
 * Nothing outside this module may mark an installment as paid.
 */
import crypto from 'node:crypto';
import type { Payment, PaymentMethod, Prisma } from '../../generated/prisma/client';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { AuditAction, AuditEntity } from '../../utils/auditActions';
import { formatBdt } from '../../utils/money';
import { badRequest, conflict, notFound, NotFoundError, unprocessable } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { recordAudit, recordAuditTx, type AuditContext } from '../audit/audit.service';
import * as linkService from './link.service';
import { getGateway, type GatewayTransaction } from './gateway';
import { GatewayError } from './gateway/types';

export interface PaymentActor extends AuditContext {
  adminId: string;
}

const PAYABLE_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] as const;

/** Prisma unique-constraint violation (P2002) - e.g. a replayed gateway trxId. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
/** payments older than this are re-queried by the reconciliation job */
const RECONCILE_AFTER_MINUTES = 10;

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

export const paymentSelect = {
  id: true,
  installmentId: true,
  gateway: true,
  gatewayPaymentId: true,
  trxId: true,
  amount: true,
  status: true,
  method: true,
  manualReference: true,
  note: true,
  receiptNumber: true,
  failureReason: true,
  completedAt: true,
  createdAt: true,
  recordedByAdminId: true,
} satisfies Prisma.PaymentSelect;

export function serializePayment(payment: Payment) {
  return {
    ...payment,
    amount: payment.amount.toString(),
  };
}

/** Invoice number sent to the gateway; also what we verify on the callback. */
export function merchantInvoiceNumber(paymentId: string): string {
  return `INV-${paymentId.replace(/-/g, '').slice(0, 20).toUpperCase()}`;
}

function newReceiptNumber(prefix = 'RC'): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}-${year}${month}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// 1) start a gateway payment
// ---------------------------------------------------------------------------

export interface StartPaymentResult {
  paymentId: string;
  redirectUrl: string | null;
  gatewayPaymentId: string;
  amount: string;
  gatewayLive: boolean;
}

/**
 * Creates the Payment row and the gateway session for a valid payment link
 * token. The amount is taken from the DATABASE (never from the request) - the
 * client cannot influence what is charged.
 */
export async function startPayment(token: string, options: { ip?: string; userAgent?: string } = {}): Promise<StartPaymentResult> {
  const installment = await linkService.resolveToken(token);
  if (!installment) throw notFound('This payment link is invalid or has expired');

  const outstanding = installment.amount - installment.paidAmount;
  if (outstanding <= 0n) throw conflict('This installment is already fully paid');
  if (installment.investment.investor.status !== 'ACTIVE') throw conflict('This account is not active');

  const pending = await prisma.payment.findFirst({
    where: { installmentId: installment.id, status: { in: ['INITIATED', 'PENDING'] }, createdAt: { gt: new Date(Date.now() - 30 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });

  const gateway = getGateway();

  // Reuse a very recent pending session instead of creating a second one, so
  // double-clicks do not litter the gateway dashboard. The redirect URL is
  // recovered from rawResponse; if we never stored one (legacy row) we fall
  // through and open a fresh session rather than sending the payer nowhere.
  const storedRedirectUrl = pending
    ? (pending.rawResponse as { redirectUrl?: string } | null)?.redirectUrl ?? null
    : null;
  if (pending?.gatewayPaymentId && pending.amount === outstanding && storedRedirectUrl) {
    return {
      paymentId: pending.id,
      redirectUrl: storedRedirectUrl,
      gatewayPaymentId: pending.gatewayPaymentId,
      amount: pending.amount.toString(),
      gatewayLive: gateway.live,
    };
  }

  const payment = await prisma.payment.create({
    data: {
      installmentId: installment.id,
      gateway: 'BKASH',
      method: 'BKASH',
      amount: outstanding,
      status: 'INITIATED',
      rawResponse: { startedAt: new Date().toISOString(), ip: options.ip ?? null } as Prisma.InputJsonValue,
    },
  });

  try {
    const created = await gateway.createPayment({
      amount: outstanding,
      merchantInvoiceNumber: merchantInvoiceNumber(payment.id),
      callbackUrl: config.bkash.callbackUrl,
      payerReference: installment.investment.investor.name.split(' ')[0] ?? 'investor',
      additionalInfo: `Installment ${installment.serial}/${installment.investment.installmentCount}`,
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        gatewayPaymentId: created.gatewayPaymentId,
        status: 'PENDING',
        // `redirectUrl` is kept separately so a double-click can resume the
        // same gateway session instead of opening a second one.
        rawResponse: {
          create: created.raw,
          redirectUrl: created.redirectUrl,
          startedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await recordAudit({ adminId: null, ip: options.ip ?? null, userAgent: options.userAgent ?? null }, {
      action: AuditAction.PAYMENT_INITIATED,
      entity: AuditEntity.PAYMENT,
      entityId: payment.id,
      newValue: {
        installmentId: installment.id,
        gatewayPaymentId: created.gatewayPaymentId,
        amount: outstanding.toString(),
        gateway: gateway.name,
        live: gateway.live,
      },
    });

    logger.info(
      { paymentId: payment.id, gatewayPaymentId: created.gatewayPaymentId, amount: formatBdt(outstanding) },
      'payment started',
    );

    return {
      paymentId: payment.id,
      redirectUrl: created.redirectUrl,
      gatewayPaymentId: created.gatewayPaymentId,
      amount: outstanding.toString(),
      gatewayLive: gateway.live,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'gateway error';
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        failureReason: message.slice(0, 500),
        rawResponse: { error: message, at: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
    logger.error({ err: error, paymentId: payment.id }, 'failed to create the gateway payment');
    throw new GatewayError('Could not start the bKash payment. Please try again in a moment.');
  }
}

// ---------------------------------------------------------------------------
// 2) gateway callback / webhook
// ---------------------------------------------------------------------------

export interface CallbackResult {
  paymentId: string;
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'PENDING';
  installmentId: string;
  receiptNumber: string | null;
  token?: string | null;
}

/**
 * Handles the browser callback. Returns our own view of the outcome; the caller
 * redirects the investor to the matching SPA page. Never throws for a
 * failed/cancelled payment - only for a payment we do not know at all.
 */
export async function handleGatewayCallback(params: {
  paymentID?: string;
  status?: string;
  trxID?: string;
  ip?: string;
  userAgent?: string;
}): Promise<CallbackResult> {
  const gatewayPaymentId = params.paymentID?.trim();
  if (!gatewayPaymentId) throw badRequest('Missing paymentID');

  const payment = await prisma.payment.findUnique({ where: { gatewayPaymentId } });
  if (!payment) {
    logger.warn({ gatewayPaymentId, status: params.status }, 'callback for an unknown payment id');
    throw new NotFoundError('Payment');
  }

  // Already settled: idempotent answer (a double callback must not double-pay).
  if (payment.status === 'SUCCESS') {
    return { paymentId: payment.id, status: 'SUCCESS', installmentId: payment.installmentId, receiptNumber: payment.receiptNumber };
  }
  if (payment.status === 'FAILED' || payment.status === 'CANCELLED') {
    return {
      paymentId: payment.id,
      status: payment.status,
      installmentId: payment.installmentId,
      receiptNumber: payment.receiptNumber,
    };
  }

  const gateway = getGateway();
  let transaction: GatewayTransaction;
  try {
    transaction = await gateway.queryPayment(gatewayPaymentId);
  } catch (error) {
    logger.error({ err: error, gatewayPaymentId }, 'could not query the gateway during callback');
    return { paymentId: payment.id, status: 'PENDING', installmentId: payment.installmentId, receiptNumber: null };
  }

  // The investor cancelled or the gateway failed the payment.
  if (transaction.status === 'Cancelled' || params.status === 'cancel') {
    // The gateway only reports "Cancelled" on some payloads, so force the
    // cancelled status here instead of letting markPaymentFailed infer it.
    await markPaymentFailed(payment.id, 'Cancelled by the payer', { ...transaction, status: 'Cancelled' });
    return { paymentId: payment.id, status: 'CANCELLED', installmentId: payment.installmentId, receiptNumber: null };
  }
  if (transaction.status === 'Failed') {
    await markPaymentFailed(payment.id, transaction.rawStatusText || 'Gateway reported failure', transaction);
    return { paymentId: payment.id, status: 'FAILED', installmentId: payment.installmentId, receiptNumber: null };
  }

  // Authorised (or already completed at the gateway): execute to capture.
  let executed = transaction;
  if (transaction.status !== 'Completed') {
    try {
      executed = await gateway.executePayment(gatewayPaymentId);
    } catch (error) {
      logger.error({ err: error, gatewayPaymentId }, 'gateway execute failed');
      await markPaymentFailed(payment.id, error instanceof Error ? error.message : 'execute failed', transaction);
      return { paymentId: payment.id, status: 'FAILED', installmentId: payment.installmentId, receiptNumber: null };
    }
  }

  const verification = verifyTransaction(payment, executed);
  if (!verification.ok) {
    logger.error({ paymentId: payment.id, reason: verification.reason }, 'payment verification failed');
    await markPaymentFailed(payment.id, verification.reason, executed);
    return { paymentId: payment.id, status: 'FAILED', installmentId: payment.installmentId, receiptNumber: null };
  }

  let settled = false;
  try {
    settled = await settlePayment(payment.id, executed, { ip: params.ip, userAgent: params.userAgent });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The gateway handed us a transaction id we have already recorded for
      // another payment. Never credit it twice: flag it for manual review.
      logger.error({ paymentId: payment.id, trxId: executed.trxId }, 'duplicate gateway transaction id');
      await markPaymentFailed(payment.id, `Duplicate gateway transaction id ${executed.trxId}`, executed);
      return { paymentId: payment.id, status: 'FAILED', installmentId: payment.installmentId, receiptNumber: null };
    }
    throw error;
  }

  return {
    paymentId: payment.id,
    status: settled ? 'SUCCESS' : 'PENDING',
    installmentId: payment.installmentId,
    receiptNumber: settled ? (await prisma.payment.findUnique({ where: { id: payment.id } }))?.receiptNumber ?? null : null,
  };
}

/**
 * Verification rules - all of them must hold before money is acknowledged:
 *  - gateway status is Completed
 *  - a gateway transaction id exists
 *  - the amount matches (exactly) what we asked for
 *  - the merchant invoice number matches our payment row
 */
export function verifyTransaction(
  payment: Pick<Payment, 'id' | 'amount' | 'gatewayPaymentId'>,
  transaction: GatewayTransaction,
): { ok: true } | { ok: false; reason: string } {
  if (transaction.status !== 'Completed') {
    return { ok: false, reason: `Gateway status is ${transaction.status}` };
  }
  if (!transaction.trxId) {
    return { ok: false, reason: 'Gateway did not return a transaction id' };
  }
  if (transaction.amount !== payment.amount) {
    return {
      ok: false,
      reason: `Amount mismatch: expected ${payment.amount.toString()} poisha, gateway reported ${transaction.amount.toString()}`,
    };
  }
  const expectedInvoice = merchantInvoiceNumber(payment.id);
  if (transaction.merchantInvoiceNumber && transaction.merchantInvoiceNumber !== expectedInvoice) {
    return { ok: false, reason: `Merchant invoice mismatch: expected ${expectedInvoice}, got ${transaction.merchantInvoiceNumber}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3) settle (atomic, idempotent)
// ---------------------------------------------------------------------------

/**
 * Marks the payment SUCCESS and the installment PAID in ONE transaction.
 *
 * Concurrency: the conditional updateMany acts as a claim - only one caller can
 * move a payment out of INITIATED/PENDING, so a duplicate callback (or a
 * callback racing the reconciliation job) cannot credit the installment twice.
 */
export async function settlePayment(
  paymentId: string,
  transaction: GatewayTransaction,
  context: { ip?: string; userAgent?: string; source?: 'callback' | 'reconciliation' | 'webhook' | 'manual' } = {},
): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ['INITIATED', 'PENDING'] } },
      data: {
        status: 'SUCCESS',
        trxId: transaction.trxId,
        completedAt: new Date(),
        failureReason: null,
        rawResponse: { settled: transaction.raw } as Prisma.InputJsonValue,
      },
    });

    if (claimed.count === 0) {
      const current = await tx.payment.findUnique({ where: { id: paymentId }, select: { status: true } });
      logger.info({ paymentId, status: current?.status }, 'payment already settled - ignoring duplicate');
      return { settled: false, alreadySettled: current?.status === 'SUCCESS' };
    }

    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const installment = await tx.installment.findUniqueOrThrow({ where: { id: payment.installmentId } });

    // Guard against over-crediting: if an investor somehow completes two
    // gateway sessions for the same installment, the second one is still money
    // received (payment stays SUCCESS) but only the outstanding part is
    // credited, so paidAmount can never exceed the installment amount. The
    // surplus is flagged in the audit trail for a manual refund.
    const outstandingBefore = installment.amount - installment.paidAmount;
    const credited = outstandingBefore <= 0n ? 0n : payment.amount < outstandingBefore ? payment.amount : outstandingBefore;
    const overpaid = payment.amount - credited;
    const paidAmount = installment.paidAmount + credited;
    const fullyPaid = paidAmount >= installment.amount;
    const status = fullyPaid ? 'PAID' : 'PARTIALLY_PAID';

    const receiptNumber = payment.receiptNumber ?? newReceiptNumber(process.env.RECEIPT_PREFIX ?? 'RC');

    await tx.payment.update({ where: { id: paymentId }, data: { receiptNumber } });

    if (credited > 0n) {
      await tx.installment.update({
        where: { id: installment.id },
        data: {
          paidAmount,
          status,
          paidAt: fullyPaid ? new Date() : installment.paidAt,
          // a fully paid installment must not keep a payable link
          ...(fullyPaid ? { payTokenHash: null, tokenExpiresAt: null } : {}),
        },
      });
    }
    if (overpaid > 0n) {
      logger.warn(
        { paymentId, installmentId: installment.id, overpaid: overpaid.toString() },
        'gateway payment exceeded the outstanding installment amount - refund required',
      );
    }

    await recordAuditTx(tx, { adminId: null, ip: context.ip ?? null, userAgent: context.userAgent ?? null }, {
      action: AuditAction.PAYMENT_SUCCEEDED,
      entity: AuditEntity.PAYMENT,
      entityId: paymentId,
      oldValue: { status: payment.status },
      newValue: {
        status: 'SUCCESS',
        trxId: transaction.trxId,
        amount: payment.amount.toString(),
        installmentId: installment.id,
        installmentStatus: credited > 0n ? status : installment.status,
        credited: credited.toString(),
        overpaid: overpaid > 0n ? overpaid.toString() : undefined,
        receiptNumber,
        source: context.source ?? 'callback',
      },
    });

    return { settled: true, alreadySettled: false };
  });

  if (result.settled) {
    // Investment may now be complete (all installments settled).
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (payment) {
      const investmentId = (
        await prisma.installment.findUnique({ where: { id: payment.installmentId }, select: { investmentId: true } })
      )?.investmentId;
      if (investmentId) {
        const { recalculateInvestmentStatus } = await import('../installment/installment.service');
        await recalculateInvestmentStatus(investmentId).catch((error) =>
          logger.error({ err: error, investmentId }, 'failed to recalculate investment status'),
        );
      }
    }
    logger.info({ paymentId, trxId: transaction.trxId }, 'payment settled');
  }

  return result.settled;
}

export async function markPaymentFailed(paymentId: string, reason: string, transaction?: GatewayTransaction): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ['INITIATED', 'PENDING'] } },
      data: {
        status: transaction?.status === 'Cancelled' ? 'CANCELLED' : 'FAILED',
        failureReason: reason.slice(0, 500),
        rawResponse: { failure: transaction?.raw ?? reason } as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0) return;

    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return;

    await recordAuditTx(tx, { adminId: null }, {
      action: transaction?.status === 'Cancelled' ? AuditAction.PAYMENT_CANCELLED : AuditAction.PAYMENT_FAILED,
      entity: AuditEntity.PAYMENT,
      entityId: paymentId,
      newValue: { reason, gatewayPaymentId: payment.gatewayPaymentId, installmentId: payment.installmentId },
    });
  });
}

// ---------------------------------------------------------------------------
// 4) manual payments (cash / bank transfer recorded by an accountant)
// ---------------------------------------------------------------------------

export interface ManualPaymentInput {
  amount?: string; // BDT; defaults to the full outstanding amount
  method: Exclude<PaymentMethod, 'BKASH'>;
  reference: string;
  note?: string;
  paidAt?: string;
}

export async function recordManualPayment(installmentId: string, input: ManualPaymentInput, actor: PaymentActor) {
  const installment = await prisma.installment.findUnique({
    where: { id: installmentId },
    include: { investment: { include: { investor: true } } },
  });
  if (!installment) throw new NotFoundError('Installment');
  if (!PAYABLE_STATUSES.includes(installment.status as (typeof PAYABLE_STATUSES)[number])) {
    throw conflict(`This installment is ${installment.status.toLowerCase()} and cannot receive a payment`);
  }

  const outstanding = installment.amount - installment.paidAmount;
  const amount = input.amount ? BigInt(Math.round(Number(input.amount.replace(/,/g, '')) * 100)) : outstanding;
  if (amount <= 0n) throw unprocessable('Payment amount must be greater than zero');
  if (amount > outstanding) {
    throw unprocessable(`Payment exceeds the outstanding amount of ${formatBdt(outstanding)}`);
  }
  if (!input.reference || input.reference.trim().length < 3) {
    throw badRequest('A reference (receipt no., bank slip no., etc.) is required for manual payments');
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        installmentId,
        gateway: 'MANUAL',
        method: input.method,
        amount,
        status: 'SUCCESS',
        manualReference: input.reference.trim(),
        note: input.note ?? null,
        recordedByAdminId: actor.adminId,
        completedAt: input.paidAt ? new Date(input.paidAt) : new Date(),
        trxId: input.reference.trim(),
      },
    });

    const paidAmount = installment.paidAmount + amount;
    const fullyPaid = paidAmount >= installment.amount;
    const status = fullyPaid ? 'PAID' : 'PARTIALLY_PAID';
    const receiptNumber = newReceiptNumber(process.env.RECEIPT_PREFIX ?? 'RC');

    await tx.payment.update({ where: { id: payment.id }, data: { receiptNumber } });
    await tx.installment.update({
      where: { id: installmentId },
      data: {
        paidAmount,
        status,
        paidAt: fullyPaid ? new Date() : installment.paidAt,
        ...(fullyPaid ? { payTokenHash: null, tokenExpiresAt: null } : {}),
      },
    });

    await recordAuditTx(tx, actor, {
      action: AuditAction.PAYMENT_MANUAL_RECORDED,
      entity: AuditEntity.PAYMENT,
      entityId: payment.id,
      newValue: {
        installmentId,
        amount: amount.toString(),
        method: input.method,
        reference: input.reference,
        note: input.note ?? null,
        installmentStatus: status,
        receiptNumber,
      },
    });

    return { paymentId: payment.id, receiptNumber, status, paidAmount: paidAmount.toString() };
  });

  const investmentId = installment.investmentId;
  const { recalculateInvestmentStatus } = await import('../installment/installment.service');
  await recalculateInvestmentStatus(investmentId).catch(() => undefined);

  logger.info({ installmentId, amount: amount.toString(), by: actor.adminId }, 'manual payment recorded');
  return result;
}

// ---------------------------------------------------------------------------
// 5) reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationSummary {
  checked: number;
  settled: number;
  failed: number;
  stillPending: number;
  errors: number;
}

/**
 * Re-queries every payment that is stuck in INITIATED/PENDING with the gateway
 * and settles the ones that actually succeeded (the callback may be lost if the
 * investor closes the browser, the network drops, or the server restarts).
 */
export async function reconcileStalePayments(options: { olderThanMinutes?: number; limit?: number } = {}): Promise<ReconciliationSummary> {
  const olderThanMinutes = options.olderThanMinutes ?? RECONCILE_AFTER_MINUTES;
  const gateway = getGateway();

  const stale = await prisma.payment.findMany({
    where: {
      status: { in: ['INITIATED', 'PENDING'] },
      gatewayPaymentId: { not: null },
      createdAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) },
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 100,
  });

  const summary: ReconciliationSummary = { checked: stale.length, settled: 0, failed: 0, stillPending: 0, errors: 0 };

  for (const payment of stale) {
    try {
      const transaction = await gateway.queryPayment(payment.gatewayPaymentId!);

      if (transaction.status === 'Completed') {
        const verification = verifyTransaction(payment, transaction);
        if (!verification.ok) {
          await markPaymentFailed(payment.id, `Reconciliation: ${verification.reason}`, transaction);
          summary.failed += 1;
          continue;
        }
        let settled = false;
        try {
          settled = await settlePayment(payment.id, transaction, { source: 'reconciliation' });
        } catch (error) {
          if (isUniqueViolation(error)) {
            await markPaymentFailed(payment.id, `Duplicate gateway transaction id ${transaction.trxId}`, transaction);
            summary.failed += 1;
            continue;
          }
          throw error;
        }
        if (settled) {
          summary.settled += 1;
          await recordAudit({ adminId: null }, {
            action: AuditAction.PAYMENT_RECONCILED,
            entity: AuditEntity.PAYMENT,
            entityId: payment.id,
            newValue: { trxId: transaction.trxId, amount: payment.amount.toString() },
          });
        }
      } else if (transaction.status === 'Failed' || transaction.status === 'Cancelled') {
        await markPaymentFailed(payment.id, `Reconciliation: gateway says ${transaction.status}`, transaction);
        summary.failed += 1;
      } else {
        summary.stillPending += 1;
      }
    } catch (error) {
      summary.errors += 1;
      logger.warn({ err: error, paymentId: payment.id }, 'reconciliation could not query the gateway');
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// 6) webhook (optional, behind BKASH_WEBHOOK_ENABLED)
// ---------------------------------------------------------------------------

/**
 * bKash can also push transaction events. The webhook is treated as a *hint*:
 * the payload is verified with the gateway before anything is settled, so a
 * forged webhook cannot mark an installment as paid.
 */
export async function handleWebhook(payload: unknown, signature?: string): Promise<{ accepted: boolean; reason?: string }> {
  if (!config.bkash.webhookEnabled) return { accepted: false, reason: 'webhooks are disabled' };

  if (config.bkash.webhookSecret) {
    if (signature !== config.bkash.webhookSecret) {
      logger.warn('webhook rejected: bad signature');
      return { accepted: false, reason: 'invalid signature' };
    }
  }

  const body = payload as { paymentID?: string; trxID?: string; transactionStatus?: string } | null;
  if (!body?.paymentID) return { accepted: false, reason: 'missing paymentID' };

  const payment = await prisma.payment.findUnique({ where: { gatewayPaymentId: body.paymentID } });
  if (!payment) return { accepted: false, reason: 'unknown payment' };

  // Always confirm with the gateway - never act on the webhook payload alone.
  return handleGatewayCallback({ paymentID: body.paymentID, status: body.transactionStatus, trxID: body.trxID }).then(
    () => ({ accepted: true }),
    (error: unknown) => ({ accepted: false, reason: error instanceof Error ? error.message : 'error' }),
  );
}

// ---------------------------------------------------------------------------
// 7) queries used by the admin UI / reports
// ---------------------------------------------------------------------------

export async function listPayments(query: {
  status?: 'INITIATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
  method?: PaymentMethod;
  gateway?: 'BKASH' | 'NAGAD' | 'MANUAL';
  investorId?: string;
  from?: string;
  to?: string;
  search?: string;
  page: number;
  pageSize: number;
}) {
  const { buildPaginated, skipTake } = await import('../../utils/http');
  const where: Prisma.PaymentWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.gateway ? { gateway: query.gateway } : {}),
    ...(query.investorId ? { installment: { investment: { investorId: query.investorId } } } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
    // NOTE: SQLite's LIKE (what Prisma's `contains` compiles to) is case-insensitive for
    // ASCII, so the PostgreSQL-only `mode: 'insensitive'` argument is not needed - SQLite
    // rejects it. Non-ASCII text (e.g. Bangla) is compared case-sensitively.
    ...(query.search
      ? {
          OR: [
            { trxId: { contains: query.search } },
            { gatewayPaymentId: { contains: query.search } },
            { manualReference: { contains: query.search } },
            { receiptNumber: { contains: query.search } },
            { installment: { investment: { investor: { name: { contains: query.search } } } } },
          ],
        }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        installment: {
          select: {
            id: true,
            serial: true,
            status: true,
            investmentId: true,
            investment: { select: { id: true, investor: { select: { id: true, name: true, mobile: true } } } },
          },
        },
        recordedByAdmin: { select: { id: true, name: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  return buildPaginated(rows.map((row) => serializePayment(row)), total, query.page, query.pageSize);
}

export async function getPaymentById(id: string) {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      installment: {
        include: {
          investment: { include: { investor: true } },
        },
      },
    },
  });
  if (!payment) throw new NotFoundError('Payment');
  return payment;
}

/** Aggregates used by the dashboard. */
export async function paymentTotals(from: Date, to: Date) {
  const rows = await prisma.payment.aggregate({
    where: { status: 'SUCCESS', completedAt: { gte: from, lte: to } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { amount: rows._sum.amount ?? 0n, count: rows._count._all };
}

export const paymentService = {
  startPayment,
  handleGatewayCallback,
  handleWebhook,
  verifyTransaction,
  settlePayment,
  markPaymentFailed,
  recordManualPayment,
  reconcileStalePayments,
  listPayments,
  getPaymentById,
  paymentTotals,
  merchantInvoiceNumber,
  serializePayment,
};
export default paymentService;
