/**
 * Reports: due/overdue book, collection register, investor statements and the
 * Excel/PDF exports built on top of them.
 *
 * Everything is paginated and filterable; exports reuse the same queries so the
 * numbers on screen and in the spreadsheet always agree.
 */
import type { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../config/prisma';
import { buildPaginated, skipTake } from '../../utils/http';
import { serializeMoney } from '../../utils/money';
import { startOfDhakaDay, addDhakaDays, daysUntil } from '../../utils/dates';
import { NotFoundError } from '../../utils/errors';
import { serializeInstallment } from '../installment/installment.service';
import { buildWorkbook, type SheetSpec } from './excel.service';

// ---------------------------------------------------------------------------
// due / overdue
// ---------------------------------------------------------------------------

export interface DueReportFilters {
  from?: string;
  to?: string;
  status?: 'PENDING' | 'PARTIALLY_PAID' | 'OVERDUE';
  investorId?: string;
  overdueOnly?: boolean;
  page: number;
  pageSize: number;
}

function dueWhere(filters: Omit<DueReportFilters, 'page' | 'pageSize'>): Prisma.InstallmentWhereInput {
  const statuses = filters.status
    ? [filters.status]
    : filters.overdueOnly
      ? ['OVERDUE']
      : ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'];

  return {
    status: { in: statuses as ('PENDING' | 'PARTIALLY_PAID' | 'OVERDUE')[] },
    ...(filters.from || filters.to
      ? {
          dueDate: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(filters.to) } : {}),
          },
        }
      : {}),
    ...(filters.investorId ? { investment: { investorId: filters.investorId } } : {}),
    investment: {
      status: 'ACTIVE',
      ...(filters.investorId ? { investorId: filters.investorId } : {}),
    },
  };
}

export async function dueReport(filters: DueReportFilters) {
  const where = dueWhere(filters);
  const { skip, take } = skipTake(filters.page, filters.pageSize);
  const today = startOfDhakaDay();

  const [rows, total, agg] = await Promise.all([
    prisma.installment.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { serial: 'asc' }],
      skip,
      take,
      include: {
        investment: {
          select: {
            id: true,
            installmentCount: true,
            totalAmount: true,
            status: true,
            investor: { select: { id: true, name: true, mobile: true, status: true } },
          },
        },
      },
    }),
    prisma.installment.count({ where }),
    prisma.installment.aggregate({ where, _sum: { amount: true, paidAmount: true } }),
  ]);

  const items = rows.map((row) => ({
    ...serializeInstallment(row, {
      hasActiveLink: Boolean(row.payTokenHash && (!row.tokenExpiresAt || row.tokenExpiresAt > new Date())),
    }),
    outstanding: (row.amount - row.paidAmount).toString(),
    overdue: row.status === 'OVERDUE' || (row.status !== 'PAID' && row.dueDate < today),
    daysOverdue: row.dueDate < today ? Math.max(0, -daysUntil(row.dueDate)) : 0,
    dueInDays: row.dueDate >= today ? daysUntil(row.dueDate) : 0,
    investor: {
      id: row.investment.investor.id,
      name: row.investment.investor.name,
      mobile: row.investment.investor.mobile,
      status: row.investment.investor.status,
    },
  }));

  const amounts = agg._sum;
  return {
    ...buildPaginated(items, total, filters.page, filters.pageSize),
    totals: {
      contracted: (amounts.amount ?? 0n).toString(),
      paid: (amounts.paidAmount ?? 0n).toString(),
      outstanding: ((amounts.amount ?? 0n) - (amounts.paidAmount ?? 0n)).toString(),
    },
  };
}

/** Rows for the Excel export - no pagination, hard capped for safety. */
async function dueRows(filters: Omit<DueReportFilters, 'page' | 'pageSize'>) {
  const rows = await prisma.installment.findMany({
    where: dueWhere(filters),
    orderBy: [{ dueDate: 'asc' }, { serial: 'asc' }],
    take: 5000,
    include: {
      investment: {
        select: {
          installmentCount: true,
          investor: { select: { id: true, name: true, mobile: true } },
        },
      },
    },
  });

  const today = startOfDhakaDay();
  return rows.map((row) => ({
    dueDate: row.dueDate,
    investor: row.investment.investor.name,
    mobile: row.investment.investor.mobile,
    installment: `${row.serial}/${row.investment.installmentCount}`,
    amount: row.amount,
    paid: row.paidAmount,
    outstanding: row.amount - row.paidAmount,
    status: row.status,
    overdueDays: row.dueDate < today && row.status !== 'PAID' ? Math.max(0, -daysUntil(row.dueDate)) : 0,
    lastRemindedAt: row.lastRemindedAt,
  }));
}

// ---------------------------------------------------------------------------
// collections register
// ---------------------------------------------------------------------------

export interface CollectionFilters {
  from?: string;
  to?: string;
  method?: 'BKASH' | 'CASH' | 'BANK' | 'OTHER';
  page: number;
  pageSize: number;
}

function collectionWhere(filters: Omit<CollectionFilters, 'page' | 'pageSize'>): Prisma.PaymentWhereInput {
  return {
    status: 'SUCCESS',
    ...(filters.method ? { method: filters.method } : {}),
    ...(filters.from || filters.to
      ? {
          completedAt: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(filters.to) } : {}),
          },
        }
      : {}),
  };
}

export async function collectionReport(filters: CollectionFilters) {
  const where = collectionWhere(filters);
  const { skip, take } = skipTake(filters.page, filters.pageSize);

  const [rows, total, agg, byMethod] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { completedAt: 'desc' },
      skip,
      take,
      include: {
        installment: {
          select: {
            serial: true,
            investment: { select: { installmentCount: true, investor: { select: { id: true, name: true } } } },
          },
        },
        recordedByAdmin: { select: { id: true, name: true } },
      },
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amount: true } }),
    prisma.payment.groupBy({ by: ['method'], where, _sum: { amount: true }, _count: { _all: true } }),
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    amount: row.amount.toString(),
    method: row.method,
    gateway: row.gateway,
    status: row.status,
    trxId: row.trxId,
    receiptNumber: row.receiptNumber,
    manualReference: row.manualReference,
    completedAt: row.completedAt,
    investor: {
      id: row.installment.investment.investor.id,
      name: row.installment.investment.investor.name,
    },
    installment: {
      serial: row.installment.serial,
      installmentCount: row.installment.investment.installmentCount,
    },
    recordedBy: row.recordedByAdmin,
  }));

  return {
    ...buildPaginated(items, total, filters.page, filters.pageSize),
    totals: {
      amount: (agg._sum.amount ?? 0n).toString(),
      count: total,
      byMethod: byMethod.map((row) => ({
        method: row.method,
        amount: (row._sum.amount ?? 0n).toString(),
        count: row._count._all,
      })),
    },
  };
}

async function collectionRows(filters: Omit<CollectionFilters, 'page' | 'pageSize'>) {
  const rows = await prisma.payment.findMany({
    where: collectionWhere(filters),
    orderBy: { completedAt: 'asc' },
    take: 10_000,
    include: {
      installment: {
        select: {
          serial: true,
          investment: { select: { installmentCount: true, investor: { select: { name: true } } } },
        },
      },
      recordedByAdmin: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    completedAt: row.completedAt,
    investor: row.installment.investment.investor.name,
    installment: `${row.installment.serial}/${row.installment.investment.installmentCount}`,
    method: row.method,
    amount: row.amount,
    trxId: row.trxId ?? '',
    reference: row.manualReference ?? '',
    receiptNumber: row.receiptNumber ?? '',
    recordedBy: row.recordedByAdmin?.name ?? 'Online',
  }));
}

// ---------------------------------------------------------------------------
// investor statement
// ---------------------------------------------------------------------------

export async function investorStatement(investorId: string) {
  const investor = await prisma.investor.findUnique({
    where: { id: investorId },
    include: {
      investments: {
        orderBy: { createdAt: 'asc' },
        include: { installments: { orderBy: { serial: 'asc' } } },
      },
    },
  });
  if (!investor) throw new NotFoundError('Investor');

  const payments = await prisma.payment.findMany({
    where: { status: 'SUCCESS', installment: { investment: { investorId } } },
    orderBy: { completedAt: 'asc' },
    include: {
      installment: { select: { serial: true, investment: { select: { id: true, installmentCount: true } } } },
    },
  });

  const contracted = investor.investments.reduce(
    (sum, investment) => sum + investment.installments.reduce((inner, row) => inner + row.amount, 0n),
    0n,
  );
  const waived = investor.investments.reduce(
    (sum, investment) => sum + investment.installments.reduce((inner, row) => (row.status === 'WAIVED' ? inner + row.amount : inner), 0n),
    0n,
  );
  const collected = payments.reduce((sum, payment) => sum + payment.amount, 0n);
  const outstanding = contracted - collected - waived > 0n ? contracted - collected - waived : 0n;

  return serializeMoney({
    investor: {
      id: investor.id,
      name: investor.name,
      mobile: investor.mobile,
      status: investor.status,
      address: investor.address,
      createdAt: investor.createdAt,
    },
    totals: { contracted, collected, waived, outstanding },
    investments: investor.investments.map((investment) => ({
      id: investment.id,
      totalAmount: investment.totalAmount,
      installmentCount: investment.installmentCount,
      status: investment.status,
      createdAt: investment.createdAt,
      installments: investment.installments.map((row) => ({
        id: row.id,
        serial: row.serial,
        amount: row.amount,
        paidAmount: row.paidAmount,
        outstanding: row.amount - row.paidAmount,
        dueDate: row.dueDate,
        status: row.status,
        paidAt: row.paidAt,
      })),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      method: payment.method,
      status: payment.status,
      trxId: payment.trxId,
      receiptNumber: payment.receiptNumber,
      completedAt: payment.completedAt,
      installment: {
        serial: payment.installment.serial,
        installmentCount: payment.installment.investment.installmentCount,
      },
    })),
  });
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export interface ExportFilters {
  due?: Omit<DueReportFilters, 'page' | 'pageSize'>;
  collections?: Omit<CollectionFilters, 'page' | 'pageSize'>;
}

export async function exportDueWorkbook(filters: Omit<DueReportFilters, 'page' | 'pageSize'>): Promise<Buffer> {
  const rows = await dueRows(filters);
  const sheet: SheetSpec = {
    name: 'Due & overdue',
    columns: [
      { header: 'Due date', key: 'dueDate', width: 14 },
      { header: 'Investor', key: 'investor', width: 26 },
      { header: 'Mobile', key: 'mobile', width: 16 },
      { header: 'Installment', key: 'installment', width: 12 },
      { header: 'Amount (BDT)', key: 'amount', money: true },
      { header: 'Paid (BDT)', key: 'paid', money: true },
      { header: 'Outstanding (BDT)', key: 'outstanding', money: true },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Days overdue', key: 'overdueDays', width: 14 },
      { header: 'Last reminded', key: 'lastRemindedAt', date: true, width: 20 },
    ],
    rows: rows.map((row) => ({ ...row, dueDate: row.dueDate.toISOString().slice(0, 10) })),
    totals: {
      amount: rows.reduce((sum, row) => sum + row.amount, 0n),
      paid: rows.reduce((sum, row) => sum + row.paid, 0n),
      outstanding: rows.reduce((sum, row) => sum + row.outstanding, 0n),
    },
  };
  return buildWorkbook([sheet], { title: 'Due and overdue installments' });
}

export async function exportCollectionsWorkbook(filters: Omit<CollectionFilters, 'page' | 'pageSize'>): Promise<Buffer> {
  const rows = await collectionRows(filters);
  const sheet: SheetSpec = {
    name: 'Collections',
    columns: [
      { header: 'Collected at', key: 'completedAt', date: true, width: 20 },
      { header: 'Investor', key: 'investor', width: 26 },
      { header: 'Installment', key: 'installment', width: 12 },
      { header: 'Method', key: 'method', width: 12 },
      { header: 'Amount (BDT)', key: 'amount', money: true },
      { header: 'Transaction ID', key: 'trxId', width: 24 },
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Receipt', key: 'receiptNumber', width: 20 },
      { header: 'Recorded by', key: 'recordedBy', width: 20 },
    ],
    rows,
    totals: { amount: rows.reduce((sum, row) => sum + row.amount, 0n) },
  };
  return buildWorkbook([sheet], { title: 'Collection register' });
}

export async function exportStatementWorkbook(investorId: string): Promise<{ buffer: Buffer; name: string }> {
  const statement = await investorStatement(investorId);
  const sheet: SheetSpec = {
    name: 'Statement',
    columns: [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Description', key: 'description', width: 44 },
      { header: 'Installment', key: 'installment', width: 12 },
      { header: 'Amount (BDT)', key: 'amount', money: true },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Reference', key: 'reference', width: 24 },
    ],
    rows: [
      ...statement.investments.flatMap((investment) =>
        investment.installments.map((row) => ({
          date: new Date(row.dueDate).toISOString().slice(0, 10),
          description: `Installment due - investment ${investment.id.slice(0, 8)}`,
          installment: `${row.serial}/${investment.installmentCount}`,
          amount: row.amount,
          status: row.status,
          reference: '',
        })),
      ),
      ...statement.payments.map((payment) => ({
        date: payment.completedAt ? new Date(payment.completedAt).toISOString().slice(0, 10) : '',
        description: `Payment received (${payment.method})`,
        installment: `${payment.installment.serial}/${payment.installment.installmentCount}`,
        amount: payment.amount,
        status: payment.status,
        reference: payment.receiptNumber ?? payment.trxId ?? '',
      })),
    ],
    totals: { amount: statement.totals.collected },
  };
  const buffer = await buildWorkbook([sheet], { title: `Statement - ${statement.investor.name}` });
  return { buffer, name: statement.investor.name };
}

export const reportService = {
  dueReport,
  collectionReport,
  investorStatement,
  exportDueWorkbook,
  exportCollectionsWorkbook,
  exportStatementWorkbook,
};

/** Re-exported for the controllers so they can keep hasActiveLink semantics. */
export { addDhakaDays };
