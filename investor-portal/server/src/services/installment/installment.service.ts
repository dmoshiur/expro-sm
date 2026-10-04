/**
 * Investment + installment service.
 *
 * Money rules enforced here (and again by database triggers):
 *   - every amount is an integer number of poisha
 *   - the split of a total into N installments is exact: the rounding remainder
 *     goes into the LAST installment
 *   - the installments of an investment must always sum to the investment total,
 *     including after an edit (checked in the service AND by a deferred
 *     constraint trigger at COMMIT time)
 *   - installment statuses only change through this service, so the audit trail
 *     is complete
 */
import type { AdminRole, InstallmentStatus, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { AuditAction, AuditEntity } from '../../utils/auditActions';
import { addInterval, formatDhakaDate, isPastDue, parseDhakaDate, startOfDhakaDay } from '../../utils/dates';
import { badRequest, conflict, NotFoundError, unprocessable } from '../../utils/errors';
import { buildPaginated, skipTake } from '../../utils/http';
import { bdtToPoisha, splitIntoInstallments, sumPoisha } from '../../utils/money';
import { logger } from '../../utils/logger';
import { recordAudit, recordAuditTx, type AuditContext } from '../audit/audit.service';
import type { CreateInvestmentInput, ListInstallmentsQuery, ListInvestmentsQuery, UpdateInstallmentsInput } from '../../validators/investment.validator';

export interface InvestmentActor extends AuditContext {
  adminId: string;
  role: AdminRole;
}

export interface CreateInvestmentOptions {
  /** when true, no rollback on a notification failure (used by the API layer) */
  skipAudit?: boolean;
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

export const installmentSelect = {
  id: true,
  investmentId: true,
  serial: true,
  amount: true,
  paidAmount: true,
  dueDate: true,
  status: true,
  paidAt: true,
  lastRemindedAt: true,
  tokenExpiresAt: true,
  waivedReason: true,
  cancelledReason: true,
} satisfies Prisma.InstallmentSelect;

type InstallmentRow = Prisma.InstallmentGetPayload<{ select: typeof installmentSelect }>;

export function serializeInstallment(installment: InstallmentRow, extras: { hasActiveLink?: boolean } = {}) {
  const outstanding = installment.amount - installment.paidAmount;
  return {
    id: installment.id,
    investmentId: installment.investmentId,
    serial: installment.serial,
    amount: installment.amount.toString(),
    paidAmount: installment.paidAmount.toString(),
    outstanding: (outstanding > 0n ? outstanding : 0n).toString(),
    dueDate: installment.dueDate,
    dueDateLabel: formatDhakaDate(installment.dueDate),
    status: installment.status,
    paidAt: installment.paidAt,
    lastRemindedAt: installment.lastRemindedAt,
    linkExpiresAt: installment.tokenExpiresAt,
    hasActiveLink: Boolean(extras.hasActiveLink ?? installment.tokenExpiresAt),
    isOverdue: isPastDue(installment.dueDate) && ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(installment.status),
    waivedReason: installment.waivedReason,
    cancelledReason: installment.cancelledReason,
  };
}

export function serializeInvestment(
  investment: {
    id: string;
    investorId: string;
    totalAmount: bigint;
    installmentCount: number;
    status: string;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    installments?: InstallmentRow[];
    investor?: { id: string; name: string; mobile: string } | null;
  },
) {
  const installments = investment.installments ?? [];
  const collected = installments.reduce((sum, item) => sum + item.paidAmount, 0n);
  const scheduled = sumPoisha(installments.map((item) => item.amount));
  const payable = installments
    .filter((item) => !['WAIVED', 'CANCELLED'].includes(item.status))
    .reduce((sum, item) => sum + item.amount, 0n);
  const outstanding = payable - collected;

  return {
    id: investment.id,
    investorId: investment.investorId,
    investor: investment.investor ?? undefined,
    totalAmount: investment.totalAmount.toString(),
    installmentCount: investment.installmentCount,
    status: investment.status,
    notes: investment.notes,
    createdAt: investment.createdAt,
    updatedAt: investment.updatedAt,
    scheduledTotal: scheduled.toString(),
    payableTotal: payable.toString(),
    collected: collected.toString(),
    outstanding: (outstanding > 0n ? outstanding : 0n).toString(),
    progress:
      payable === 0n ? 100 : Number((collected * 10000n) / payable) / 100,
    paidCount: installments.filter((item) => item.status === 'PAID').length,
    installments: installments.map((item) => serializeInstallment(item)),
  };
}

// ---------------------------------------------------------------------------
// planning helpers (pure - unit tested)
// ---------------------------------------------------------------------------

/**
 * Splits `totalBdt` into `count` installments of equal size with the remainder
 * added to the LAST installment, so the sum is always exact.
 */
export function planInstallments(totalBdt: string | number, count: number): bigint[] {
  return splitIntoInstallments(bdtToPoisha(totalBdt), count);
}

/** Due dates: first due date plus `index * interval` days/weeks/months/years. */
export function planDueDates(firstDueDate: string, interval: { unit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'; value: number }, count: number): Date[] {
  const first = parseDhakaDate(firstDueDate);
  return Array.from({ length: count }, (_, index) => (index === 0 ? first : addInterval(first, interval.unit, interval.value * index)));
}

// ---------------------------------------------------------------------------
// investment lifecycle
// ---------------------------------------------------------------------------

export async function createInvestment(input: CreateInvestmentInput, actor: InvestmentActor) {
  const investor = await prisma.investor.findUnique({ where: { id: input.investorId } });
  if (!investor) throw new NotFoundError('Investor');
  if (investor.status !== 'ACTIVE') throw unprocessable('Cannot create an investment for an inactive investor');

  const amounts = planInstallments(input.totalAmount, input.installmentCount);
  const dueDates = planDueDates(input.firstDueDate, input.interval, input.installmentCount);
  const total = bdtToPoisha(input.totalAmount);

  if (sumPoisha(amounts) !== total) {
    // defensive: splitIntoInstallments guarantees this
    throw badRequest('Internal error: installment split does not match the total');
  }

  const investment = await prisma.$transaction(async (tx) => {
    const created = await tx.investment.create({
      data: {
        investorId: input.investorId,
        totalAmount: total,
        installmentCount: input.installmentCount,
        status: 'ACTIVE',
        notes: input.notes ?? null,
      },
    });

    for (let index = 0; index < amounts.length; index += 1) {
      await tx.installment.create({
        data: {
          investmentId: created.id,
          serial: index + 1,
          amount: amounts[index]!,
          dueDate: dueDates[index]!,
          status: 'PENDING',
        },
      });
    }

    await recordAuditTx(tx, actor, {
      action: AuditAction.INVESTMENT_CREATED,
      entity: AuditEntity.INVESTMENT,
      entityId: created.id,
      newValue: {
        investorId: input.investorId,
        investorName: investor.name,
        totalAmount: total.toString(),
        installmentCount: input.installmentCount,
        firstDueDate: input.firstDueDate,
        interval: input.interval,
        amounts: amounts.map(String),
      },
    });

    return created;
  });

  logger.info({ investmentId: investment.id, total: total.toString(), count: input.installmentCount }, 'investment created');
  return getInvestmentById(investment.id);
}

export async function getInvestmentById(id: string) {
  const investment = await prisma.investment.findUnique({
    where: { id },
    include: {
      installments: { orderBy: { serial: 'asc' }, select: installmentSelect },
      investor: { select: { id: true, name: true, mobile: true } },
    },
  });
  if (!investment) throw new NotFoundError('Investment');

  const successPayments = await prisma.payment.findMany({
    where: { installmentId: { in: investment.installments.map((item) => item.id) }, status: 'SUCCESS' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      installmentId: true,
      gateway: true,
      method: true,
      amount: true,
      trxId: true,
      status: true,
      receiptNumber: true,
      completedAt: true,
      createdAt: true,
      manualReference: true,
    },
  });

  return {
    ...serializeInvestment(investment),
    investor: investment.investor,
    payments: successPayments.map((payment) => ({ ...payment, amount: payment.amount.toString() })),
  };
}

export async function listInvestments(query: ListInvestmentsQuery, _role: AdminRole) {
  const where: Prisma.InvestmentWhereInput = {
    ...(query.investorId ? { investorId: query.investorId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          investor: {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { mobile: { contains: query.search } },
            ],
          },
        }
      : {}),
    ...(query.onlyOverdue
      ? { installments: { some: { status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] }, dueDate: { lt: startOfDhakaDay() } } } }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const orderBy: Prisma.InvestmentOrderByWithRelationInput =
    query.sortBy === 'totalAmount' ? { totalAmount: query.sortDir } : { [query.sortBy]: query.sortDir };

  const [rows, total] = await Promise.all([
    prisma.investment.findMany({
      where,
      orderBy,
      skip,
      take,
      include: {
        installments: { select: installmentSelect },
        investor: { select: { id: true, name: true, mobile: true } },
      },
    }),
    prisma.investment.count({ where }),
  ]);

  return buildPaginated(rows.map((row) => serializeInvestment(row)), total, query.page, query.pageSize);
}

export async function updateInvestment(id: string, input: { notes?: string | null; status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' }, actor: InvestmentActor) {
  const existing = await prisma.investment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Investment');

  await prisma.$transaction(async (tx) => {
    await tx.investment.update({
      where: { id },
      data: {
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    });
    await recordAuditTx(tx, actor, {
      action: AuditAction.INVESTMENT_UPDATED,
      entity: AuditEntity.INVESTMENT,
      entityId: id,
      oldValue: { notes: existing.notes, status: existing.status },
      newValue: input,
    });
  });

  return getInvestmentById(id);
}

/**
 * Cancels an investment: every unpaid installment becomes CANCELLED, paid ones
 * stay PAID (the money was really collected).
 */
export async function cancelInvestment(id: string, reason: string, actor: InvestmentActor) {
  const investment = await prisma.investment.findUnique({ where: { id }, include: { installments: true } });
  if (!investment) throw new NotFoundError('Investment');
  if (investment.status === 'CANCELLED') throw conflict('This investment is already cancelled');

  const paid = investment.installments.filter((item) => item.status === 'PAID');
  if (paid.length > 0 && paid.some((item) => item.paidAmount > 0n)) {
    // allow it, but the refund decision is a human one - record it loudly
    logger.warn({ investmentId: id, paidInstallments: paid.length }, 'cancelling an investment that already collected money');
  }

  const affected = investment.installments.filter((item) => !['PAID', 'WAIVED', 'CANCELLED'].includes(item.status)).map((item) => item.id);

  await prisma.$transaction(async (tx) => {
    if (affected.length > 0) {
      await tx.installment.updateMany({
        where: { id: { in: affected } },
        data: { status: 'CANCELLED', cancelledReason: reason },
      });
    }
    await tx.investment.update({ where: { id }, data: { status: 'CANCELLED' } });
    await recordAuditTx(tx, actor, {
      action: AuditAction.INVESTMENT_CANCELLED,
      entity: AuditEntity.INVESTMENT,
      entityId: id,
      oldValue: { status: investment.status },
      newValue: { status: 'CANCELLED', reason, cancelledInstallments: affected.length },
    });
  });

  return getInvestmentById(id);
}

// ---------------------------------------------------------------------------
// installment editing / waiving
// ---------------------------------------------------------------------------

/**
 * Bulk edit of amounts and/or due dates. Payments already made cannot be
 * invalidated: an installment with a SUCCESS payment may only have its due date
 * changed.
 */
export async function updateInstallments(investmentId: string, input: UpdateInstallmentsInput, actor: InvestmentActor) {
  const investment = await prisma.investment.findUnique({
    where: { id: investmentId },
    include: { installments: { orderBy: { serial: 'asc' } } },
  });
  if (!investment) throw new NotFoundError('Investment');

  const byId = new Map(investment.installments.map((item) => [item.id, item]));
  for (const change of input.installments) {
    if (!byId.has(change.id)) throw badRequest('One of the installments does not belong to this investment');
  }

  const paidInstallmentIds = new Set(
    (
      await prisma.payment.findMany({
        where: { installmentId: { in: input.installments.map((item) => item.id) }, status: 'SUCCESS' },
        select: { installmentId: true },
      })
    ).map((row) => row.installmentId),
  );

  const proposed = investment.installments.map((item) => {
    const change = input.installments.find((candidate) => candidate.id === item.id);
    if (!change) return { item, amount: item.amount, dueDate: item.dueDate };
    if (change.amount !== undefined && paidInstallmentIds.has(item.id)) {
      throw conflict('This installment already has a successful payment - only the due date can be changed');
    }
    if (change.amount !== undefined && ['WAIVED', 'CANCELLED'].includes(item.status)) {
      throw conflict(`A ${item.status.toLowerCase()} installment cannot be re-priced`);
    }
    return {
      item,
      amount: change.amount === undefined ? item.amount : bdtToPoisha(change.amount),
      dueDate: change.dueDate === undefined ? item.dueDate : parseDhakaDate(change.dueDate),
    };
  });

  const total = sumPoisha(proposed.map((entry) => entry.amount));
  if (total !== investment.totalAmount) {
    throw unprocessable(
      `Installment amounts must add up to the investment total: expected ${investment.totalAmount.toString()} poisha, got ${total.toString()}`,
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const entry of proposed) {
      if (entry.amount === entry.item.amount && entry.dueDate.getTime() === entry.item.dueDate.getTime()) continue;
      await tx.installment.update({
        where: { id: entry.item.id },
        data: {
          amount: entry.amount,
          dueDate: entry.dueDate,
          // a past-due installment that is edited keeps its overdue flag
          status:
            entry.item.status === 'PENDING' && isPastDue(entry.dueDate) ? 'OVERDUE' : entry.item.status === 'OVERDUE' && !isPastDue(entry.dueDate) ? 'PENDING' : entry.item.status,
        },
      });
      await recordAuditTx(tx, actor, {
        action: AuditAction.INSTALLMENT_UPDATED,
        entity: AuditEntity.INSTALLMENT,
        entityId: entry.item.id,
        oldValue: { amount: entry.item.amount.toString(), dueDate: entry.item.dueDate.toISOString() },
        newValue: { amount: entry.amount.toString(), dueDate: entry.dueDate.toISOString() },
      });
    }
  });

  return getInvestmentById(investmentId);
}

/** Waive (forgive) an installment. Requires a reason; audited. */
export async function waiveInstallment(installmentId: string, reason: string, actor: InvestmentActor) {
  return changeInstallmentStatus(installmentId, 'WAIVED', reason, actor, AuditAction.INSTALLMENT_WAIVED);
}

/** Cancel an installment (no longer expected to be paid). Requires a reason. */
export async function cancelInstallment(installmentId: string, reason: string, actor: InvestmentActor) {
  return changeInstallmentStatus(installmentId, 'CANCELLED', reason, actor, AuditAction.INSTALLMENT_CANCELLED);
}

/** Reverses a waive/cancel back to PENDING (audited as INSTALLMENT_UNWAIVED). */
export async function reopenInstallment(installmentId: string, reason: string, actor: InvestmentActor) {
  const installment = await prisma.installment.findUnique({ where: { id: installmentId } });
  if (!installment) throw new NotFoundError('Installment');
  if (!['WAIVED', 'CANCELLED'].includes(installment.status)) throw conflict('Only a waived or cancelled installment can be reopened');

  await prisma.$transaction(async (tx) => {
    await tx.installment.update({
      where: { id: installmentId },
      data: { status: isPastDue(installment.dueDate) ? 'OVERDUE' : 'PENDING', waivedReason: null, cancelledReason: null },
    });
    await recordAuditTx(tx, actor, {
      action: AuditAction.INSTALLMENT_UNWAIVED,
      entity: AuditEntity.INSTALLMENT,
      entityId: installmentId,
      oldValue: { status: installment.status, reason: installment.waivedReason ?? installment.cancelledReason },
      newValue: { status: 'PENDING', reason },
    });
  });

  return recalculateInvestmentStatus(installment.investmentId, actor);
}

async function changeInstallmentStatus(
  installmentId: string,
  status: Extract<InstallmentStatus, 'WAIVED' | 'CANCELLED'>,
  reason: string,
  actor: InvestmentActor,
  action: string,
) {
  const installment = await prisma.installment.findUnique({ where: { id: installmentId } });
  if (!installment) throw new NotFoundError('Installment');
  if (installment.status === 'PAID') throw conflict('A paid installment cannot be waived or cancelled');
  if (installment.status === status) throw conflict(`This installment is already ${status.toLowerCase()}`);

  const payments = await prisma.payment.count({ where: { installmentId, status: 'SUCCESS' } });
  if (payments > 0) throw conflict('This installment has received money and cannot be waived');

  await prisma.$transaction(async (tx) => {
    await tx.installment.update({
      where: { id: installmentId },
      data: {
        status,
        ...(status === 'WAIVED' ? { waivedReason: reason, cancelledReason: null } : { cancelledReason: reason, waivedReason: null }),
        // a waived/cancelled installment must not keep a payable link
        payTokenHash: null,
      },
    });
    await recordAuditTx(tx, actor, {
      action,
      entity: AuditEntity.INSTALLMENT,
      entityId: installmentId,
      oldValue: { status: installment.status, amount: installment.amount.toString() },
      newValue: { status, reason },
    });
  });

  logger.info({ installmentId, status, by: actor.adminId }, 'installment status changed');
  return recalculateInvestmentStatus(installment.investmentId, actor);
}

/**
 * An investment is COMPLETED once nothing is left to collect: every installment
 * is PAID, WAIVED or CANCELLED.
 */
export async function recalculateInvestmentStatus(investmentId: string, actor?: InvestmentActor) {
  const investment = await prisma.investment.findUnique({ where: { id: investmentId }, include: { installments: true } });
  if (!investment) throw new NotFoundError('Investment');

  const open = investment.installments.filter((item) => ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(item.status));
  const nextStatus = investment.status === 'CANCELLED' ? 'CANCELLED' : open.length === 0 ? 'COMPLETED' : 'ACTIVE';

  if (nextStatus !== investment.status) {
    await prisma.$transaction(async (tx) => {
      await tx.investment.update({ where: { id: investmentId }, data: { status: nextStatus } });
      if (actor) {
        await recordAuditTx(tx, actor, {
          action: AuditAction.INSTALLMENT_STATUS_CHANGED,
          entity: AuditEntity.INVESTMENT,
          entityId: investmentId,
          oldValue: { status: investment.status },
          newValue: { status: nextStatus, reason: 'recalculated after installment change' },
        });
      }
    });
  }

  return getInvestmentById(investmentId);
}

// ---------------------------------------------------------------------------
// listings used by reports
// ---------------------------------------------------------------------------

export async function listInstallments(query: ListInstallmentsQuery) {
  const statuses = query.statuses?.split(',').filter(Boolean) as InstallmentStatus[] | undefined;
  const where: Prisma.InstallmentWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(statuses && statuses.length > 0 ? { status: { in: statuses } } : {}),
    ...(query.from || query.to
      ? {
          dueDate: {
            ...(query.from ? { gte: parseDhakaDate(query.from) } : {}),
            ...(query.to ? { lte: parseDhakaDate(query.to) } : {}),
          },
        }
      : {}),
    ...(query.investorId ? { investment: { investorId: query.investorId } } : {}),
    ...(query.overdueOnly
      ? { status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] }, dueDate: { lt: startOfDhakaDay() } }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const [rows, total] = await Promise.all([
    prisma.installment.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { serial: 'asc' }],
      skip,
      take,
      include: {
        investment: {
          select: {
            id: true,
            status: true,
            investorId: true,
            investor: { select: { id: true, name: true, mobile: true } },
          },
        },
      },
    }),
    prisma.installment.count({ where }),
  ]);

  const items = rows.map((row) => ({
    ...serializeInstallment(row),
    investor: row.investment.investor,
    investmentStatus: row.investment.status,
  }));

  return buildPaginated(items, total, query.page, query.pageSize);
}

/** Latest successful payment per installment (used by the timeline UI). */
export async function latestPaymentsForInstallments(installmentIds: string[]) {
  if (installmentIds.length === 0) return new Map<string, { trxId: string | null; completedAt: Date | null; method: string }>();
  const payments = await prisma.payment.findMany({
    where: { installmentId: { in: installmentIds }, status: 'SUCCESS' },
    orderBy: { completedAt: 'desc' },
    select: { installmentId: true, trxId: true, completedAt: true, method: true },
  });
  const map = new Map<string, { trxId: string | null; completedAt: Date | null; method: string }>();
  for (const payment of payments) {
    if (!map.has(payment.installmentId)) {
      map.set(payment.installmentId, { trxId: payment.trxId, completedAt: payment.completedAt, method: payment.method });
    }
  }
  return map;
}

export async function getInstallmentForPayment(installmentId: string, tx: Tx | typeof prisma = prisma) {
  const installment = await tx.installment.findUnique({
    where: { id: installmentId },
    include: { investment: { include: { investor: true } } },
  });
  if (!installment) throw new NotFoundError('Installment');
  return installment;
}

export async function recordReminderSent(installmentId: string, at = new Date()): Promise<void> {
  await prisma.installment.update({ where: { id: installmentId }, data: { lastRemindedAt: at } });
}

export async function auditInstallmentEvent(actor: InvestmentActor, installmentId: string, action: string, value: unknown) {
  await recordAudit(actor, { action, entity: AuditEntity.INSTALLMENT, entityId: installmentId, newValue: value });
}

export const installmentService = {
  createInvestment,
  getInvestmentById,
  listInvestments,
  updateInvestment,
  cancelInvestment,
  updateInstallments,
  waiveInstallment,
  cancelInstallment,
  reopenInstallment,
  recalculateInvestmentStatus,
  listInstallments,
  latestPaymentsForInstallments,
  planInstallments,
  planDueDates,
  serializeInvestment,
  serializeInstallment,
};
export default installmentService;
