/**
 * Overdue marker - runs daily at 00:05 Asia/Dhaka.
 *
 * Any installment that is still PENDING or PARTIALLY_PAID and whose due date is
 * before today (Dhaka) becomes OVERDUE. PAID / WAIVED / CANCELLED installments
 * are never touched. The change is audited as a system action.
 */
import { AuditAction } from '../utils/auditActions';
import { prisma } from '../config/prisma';
import { startOfDhakaDay } from '../utils/dates';
import { jobLogger } from '../utils/logger';
import type { JobContext, JobResult } from './scheduler';

export async function overdueInstallmentsJob(context: JobContext): Promise<JobResult> {
  const log = context.logger ?? jobLogger('overdue-installments');
  const today = startOfDhakaDay();

  const candidates = await prisma.installment.findMany({
    where: {
      status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      dueDate: { lt: today },
    },
    select: { id: true, investmentId: true, serial: true, amount: true, paidAmount: true, status: true, dueDate: true },
  });

  if (candidates.length === 0) {
    return { summary: 'no installments became overdue', metrics: { marked: 0 } };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.installment.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: 'OVERDUE' },
    });

    // One audit row per investment keeps the trail readable without flooding
    // the audit table on very large datasets.
    const byInvestment = new Map<string, typeof candidates>();
    for (const installment of candidates) {
      const list = byInvestment.get(installment.investmentId) ?? [];
      list.push(installment);
      byInvestment.set(installment.investmentId, list);
    }
    for (const [investmentId, list] of byInvestment) {
      await tx.auditLog.create({
        data: {
          action: AuditAction.INSTALLMENT_STATUS_CHANGED,
          entity: 'Investment',
          entityId: investmentId,
          oldValue: { statuses: list.map((i) => ({ serial: i.serial, status: i.status })) },
          newValue: { status: 'OVERDUE', serials: list.map((i) => i.serial) },
        },
      });
    }
    return result.count;
  });

  log.info({ marked: updated }, 'installments marked overdue');
  return { summary: `${updated} installment(s) marked OVERDUE`, metrics: { marked: updated } };
}

export default overdueInstallmentsJob;
