/**
 * Payment link service.
 *
 * Security properties:
 *  - the token is 32 random bytes (base64url, 43 chars) generated with
 *    crypto.randomBytes - not guessable
 *  - only the SHA-256 hash is stored (`installments.payTokenHash`), so a
 *    database leak does not expose usable links
 *  - links expire (PAYMENT_LINK_TTL_DAYS, default 7) and every lookup is
 *    validated against the expiry
 *  - regenerating a link overwrites the hash, instantly invalidating the old one
 *  - lookups are constant time and never reveal *why* a token failed
 */
import type { Prisma } from '@prisma/client';
import { config } from '../../config';
import { prisma, type Tx } from '../../config/prisma';
import { AuditAction, AuditEntity } from '../../utils/auditActions';
import { addDhakaDays, formatDhakaDate } from '../../utils/dates';
import { NotFoundError, conflict, unprocessable } from '../../utils/errors';
import { randomToken, sha256 } from '../../utils/encryption';
import { formatBdt } from '../../utils/money';
import { firstName } from '../../utils/http';
import { logger } from '../../utils/logger';
import { recordAudit, type AuditContext } from '../audit/audit.service';
import { paymentLinkMessage, sendSms } from '../sms/sms.service';

/** Installments that can be paid at all. */
const PAYABLE_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] as const;

export interface LinkContext extends AuditContext {
  adminId: string;
}

export interface GeneratedLink {
  url: string;
  token: string;
  expiresAt: Date;
}

export function paymentUrl(token: string): string {
  return `${config.appBaseUrl}/pay/${token}`;
}

export function linkTtlDays(): number {
  return config.paymentLink.ttlDays > 0 ? config.paymentLink.ttlDays : 7;
}

/**
 * Issues a fresh token for an installment. `previousHash` is replaced, so any
 * link that was shared before stops working immediately.
 */
export async function generateLink(
  installmentId: string,
  options: { ttlDays?: number; tx?: Tx; reason?: string } = {},
): Promise<GeneratedLink> {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = addDhakaDays(new Date(), options.ttlDays ?? linkTtlDays());

  await (options.tx ?? prisma).installment.update({
    where: { id: installmentId },
    data: { payTokenHash: tokenHash, tokenExpiresAt: expiresAt },
  });

  return { url: paymentUrl(token), token, expiresAt };
}

/**
 * Public lookup used by /pay/:token and the payment start endpoint.
 * Returns null for unknown, expired or non-payable tokens (never leaking which).
 */
export async function resolveToken(token: string) {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = sha256(token);

  const installment = await prisma.installment.findUnique({
    where: { payTokenHash: tokenHash },
    include: {
      investment: { include: { investor: { select: { id: true, name: true, status: true, mobile: true } } } },
      payments: {
        where: { status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, amount: true, trxId: true, completedAt: true, method: true, receiptNumber: true },
      },
    },
  });

  if (!installment) return null;
  if (installment.tokenExpiresAt && installment.tokenExpiresAt.getTime() < Date.now()) return null;
  if (!PAYABLE_STATUSES.includes(installment.status as (typeof PAYABLE_STATUSES)[number])) return null;
  if (installment.investment.status === 'CANCELLED') return null;
  if (installment.investment.investor.status === 'INACTIVE') return null;

  return installment;
}

/**
 * Minimal, privacy-preserving payload for the public page:
 * first name only, installment number, amount, due date. No NID, no mobile,
 * no address, no investor id.
 */
export async function publicPayload(token: string) {
  const installment = await resolveToken(token);
  if (!installment) throw new NotFoundError('Payment link');

  const outstanding = installment.amount - installment.paidAmount;
  return {
    firstName: firstName(installment.investment.investor.name),
    installmentSerial: installment.serial,
    installmentCount: installment.investment.installmentCount,
    amount: (outstanding > 0n ? outstanding : installment.amount).toString(),
    amountLabel: formatBdt(outstanding > 0n ? outstanding : installment.amount),
    dueDate: formatDhakaDate(installment.dueDate),
    status: installment.status,
    isOverdue: installment.status === 'OVERDUE',
    /** true when the investor already paid this installment */
    alreadyPaid: installment.status === 'PAID',
  };
}

/**
 * Regenerates the link (admin action) and, when requested, SMSes it.
 * Audited: who regenerated which link and when.
 */
export async function regenerateLink(
  installmentId: string,
  actor: LinkContext,
  options: { sendSms?: boolean } = {},
) {
  const installment = await prisma.installment.findUnique({
    where: { id: installmentId },
    include: { investment: { include: { investor: true } } },
  });
  if (!installment) throw new NotFoundError('Installment');
  if (installment.status === 'PAID') throw conflict('This installment is already paid');
  if (installment.status === 'WAIVED' || installment.status === 'CANCELLED') {
    throw conflict(`A ${installment.status.toLowerCase()} installment does not need a payment link`);
  }

  const link = await generateLink(installmentId, { reason: 'regenerated' });

  await recordAudit(actor, {
    action: AuditAction.PAYMENT_LINK_REGENERATED,
    entity: AuditEntity.INSTALLMENT,
    entityId: installmentId,
    oldValue: { tokenExpiresAt: installment.tokenExpiresAt?.toISOString() ?? null },
    newValue: { tokenExpiresAt: link.expiresAt.toISOString(), sentBySms: Boolean(options.sendSms) },
  });

  logger.info({ installmentId, by: actor.adminId }, 'payment link regenerated');

  if (options.sendSms) {
    return sendLinkForInstallment(installmentId, actor, { link });
  }

  return { link: { url: link.url, expiresAt: link.expiresAt }, sms: null };
}

/** Sends the payment link for an installment by SMS (creating one if needed). */
export async function sendLinkForInstallment(
  installmentId: string,
  actor: LinkContext,
  options: { link?: GeneratedLink },
) {
  const installment = await prisma.installment.findUnique({
    where: { id: installmentId },
    include: { investment: { include: { investor: true } } },
  });
  if (!installment) throw new NotFoundError('Installment');
  if (installment.status === 'PAID' || installment.status === 'WAIVED' || installment.status === 'CANCELLED') {
    throw conflict(`Cannot send a payment link for a ${installment.status.toLowerCase()} installment`);
  }

  const link = options.link ?? (await generateLink(installmentId));

  const body = paymentLinkMessage({
    investorName: firstName(installment.investment.investor.name),
    installmentSerial: installment.serial,
    installmentCount: installment.investment.installmentCount,
    amount: installment.amount - installment.paidAmount,
    dueDate: installment.dueDate,
    url: link.url,
  });

  const delivery = await sendSms({
    to: installment.investment.investor.mobile,
    body,
    purpose: 'PAYMENT_LINK',
    investorId: installment.investment.investorId,
    installmentId,
  });

  await recordAudit(actor, {
    action: AuditAction.PAYMENT_LINK_SENT,
    entity: AuditEntity.INSTALLMENT,
    entityId: installmentId,
    newValue: {
      to: installment.investment.investor.mobile,
      success: delivery.success,
      provider: delivery.provider,
      smsLogId: delivery.logId,
    },
  });

  return { link: { url: link.url, expiresAt: link.expiresAt }, sms: delivery };
}

/** Bulk send for every open installment of an investment. */
export async function sendLinksForInvestment(investmentId: string, actor: LinkContext) {
  const investment = await prisma.investment.findUnique({
    where: { id: investmentId },
    include: { installments: { orderBy: { serial: 'asc' } }, investor: true },
  });
  if (!investment) throw new NotFoundError('Investment');
  if (investment.investor.status !== 'ACTIVE') throw unprocessable('This investor is inactive');
  if (investment.status === 'CANCELLED') throw conflict('This investment is cancelled');

  const sendable = investment.installments.filter((item) =>
    PAYABLE_STATUSES.includes(item.status as (typeof PAYABLE_STATUSES)[number]),
  );
  if (sendable.length === 0) throw conflict('There is no open installment to remind about');

  const results: Array<{ installmentId: string; serial: number; success: boolean; error?: string }> = [];
  for (const installment of sendable) {
    try {
      const result = await sendLinkForInstallment(installment.id, actor, {});
      results.push({ installmentId: installment.id, serial: installment.serial, success: result.sms?.success ?? false });
    } catch (error) {
      results.push({
        installmentId: installment.id,
        serial: installment.serial,
        success: false,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  await recordAudit(actor, {
    action: AuditAction.PAYMENT_LINK_BULK_SENT,
    entity: AuditEntity.INVESTMENT,
    entityId: investmentId,
    newValue: { sent: results.filter((item) => item.success).length, attempted: results.length },
  });

  return {
    attempted: results.length,
    sent: results.filter((item) => item.success).length,
    failed: results.filter((item) => !item.success).length,
    results,
  };
}

/** The exact query the reminder job uses to find installments to nudge. */
export function openInstallmentsWhere(): Prisma.InstallmentWhereInput {
  return { status: { in: [...PAYABLE_STATUSES] } };
}

export const paymentLinkService = {
  generateLink,
  resolveToken,
  publicPayload,
  regenerateLink,
  sendLinkForInstallment,
  sendLinksForInvestment,
  paymentUrl,
  linkTtlDays,
};
export default paymentLinkService;
