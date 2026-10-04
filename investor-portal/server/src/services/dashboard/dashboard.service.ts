/**
 * Dashboard aggregates.
 *
 * All money is poisha (BigInt) and every date boundary is computed in
 * Asia/Dhaka, so "today's collection" means the Dhaka calendar day regardless
 * of the server timezone.
 */
import { prisma } from '../../config/prisma';
import { addDhakaDays, startOfDhakaDay } from '../../utils/dates';
import { serializeMoney } from '../../utils/money';

export interface CollectionPoint {
  month: string; // YYYY-MM
  total: string; // poisha
  count: number;
}

export interface DashboardSummary {
  totals: {
    invested: string;
    collected: string;
    outstanding: string;
    overdue: string;
    waived: string;
  };
  counts: {
    investors: number;
    activeInvestors: number;
    investments: number;
    activeInvestments: number;
    installments: number;
    paidInstallments: number;
    overdueInstallments: number;
  };
  collection: {
    today: string;
    todayCount: number;
    yesterday: string;
    thisMonth: string;
    thisMonthCount: number;
    last30Days: string;
  };
  due: {
    next7Days: string;
    next7DaysCount: number;
    overdueAmount: string;
    overdueCount: number;
  };
  collectionByMonth: CollectionPoint[];
  upcomingInstallments: Array<{
    id: string;
    serial: number;
    installmentCount: number;
    amount: string;
    outstanding: string;
    dueDate: Date;
    status: string;
    investor: { id: string; name: string; mobileMasked: boolean };
  }>;
  recentPayments: Array<{
    id: string;
    amount: string;
    method: string;
    status: string;
    completedAt: Date | null;
    createdAt: Date;
    receiptNumber: string | null;
    investorName: string;
  }>;
}

const startOfDhakaMonth = (reference = new Date()): Date => {
  const day = startOfDhakaDay(reference);
  // Dhaka midnight of the 1st: rewind by (day-of-month - 1) days.
  const dayOfMonth = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', day: 'numeric' }).format(reference),
  );
  return addDhakaDays(day, -(dayOfMonth - 1));
};

/** Sums SUCCESS payments whose completedAt falls inside [from, to). */
async function collectedBetween(from: Date, to: Date): Promise<{ amount: bigint; count: number }> {
  const rows = await prisma.payment.aggregate({
    where: { status: 'SUCCESS', completedAt: { gte: from, lt: to } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { amount: rows._sum.amount ?? 0n, count: rows._count._all };
}

export async function getSummary(months = 12): Promise<DashboardSummary> {
  const now = new Date();
  const todayStart = startOfDhakaDay(now);
  const tomorrowStart = addDhakaDays(todayStart, 1);
  const yesterdayStart = addDhakaDays(todayStart, -1);
  const monthStart = startOfDhakaMonth(now);
  const last30 = addDhakaDays(todayStart, -29);

  const [investments, activeInvestments, investors, activeInvestors, installmentAgg, paidAgg, waivedAgg] =
    await Promise.all([
      prisma.investment.aggregate({ _sum: { totalAmount: true }, _count: { _all: true } }),
      prisma.investment.aggregate({
        where: { status: 'ACTIVE' },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      prisma.investor.count(),
      prisma.investor.count({ where: { status: 'ACTIVE' } }),
      prisma.installment.aggregate({
        _sum: { amount: true, paidAmount: true },
        _count: { _all: true },
      }),
      prisma.installment.aggregate({
        where: { status: 'PAID' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.installment.aggregate({
        where: { status: 'WAIVED' },
        _sum: { amount: true },
      }),
    ]);

  const overdue = await prisma.installment.aggregate({
    where: { status: 'OVERDUE' },
    _sum: { amount: true, paidAmount: true },
    _count: { _all: true },
  });

  const dueSoon = await prisma.installment.aggregate({
    where: {
      status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      dueDate: { gte: todayStart, lt: addDhakaDays(todayStart, 7) },
    },
    _sum: { amount: true, paidAmount: true },
    _count: { _all: true },
  });

  const waived = waivedAgg._sum.amount ?? 0n;
  const collectedAgg = await prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true } });
  const collected = collectedAgg._sum.amount ?? 0n;
  const invested = investments._sum.totalAmount ?? 0n;
  const contracted = installmentAgg._sum.amount ?? 0n;

  const [today, yesterday, thisMonth, last30Days] = await Promise.all([
    collectedBetween(todayStart, tomorrowStart),
    collectedBetween(yesterdayStart, todayStart),
    collectedBetween(monthStart, tomorrowStart),
    collectedBetween(last30, tomorrowStart),
  ]);

  const collectionByMonth = await collectByMonth(months);
  const upcomingInstallments = await getUpcoming();
  const recentPayments = await getRecent();

  const overdueOutstanding = (overdue._sum.amount ?? 0n) - (overdue._sum.paidAmount ?? 0n);
  const dueSoonOutstanding = (dueSoon._sum.amount ?? 0n) - (dueSoon._sum.paidAmount ?? 0n);

  // serializeMoney converts BigInt -> string recursively; the declared shape
  // already describes the JSON form, so the cast is the type-level half of it.
  return serializeMoney({
    totals: {
      invested,
      collected,
      // outstanding is derived from the installments (the single source of
      // truth for what the investor still owes) minus waived amounts.
      outstanding: contracted - collected - waived > 0n ? contracted - collected - waived : 0n,
      overdue: overdueOutstanding > 0n ? overdueOutstanding : 0n,
      waived,
    },
    counts: {
      investors,
      activeInvestors,
      investments: investments._count._all,
      activeInvestments: activeInvestments._count._all,
      installments: installmentAgg._count._all,
      paidInstallments: paidAgg._count._all,
      overdueInstallments: overdue._count._all,
    },
    collection: {
      today: today.amount,
      todayCount: today.count,
      yesterday: yesterday.amount,
      thisMonth: thisMonth.amount,
      thisMonthCount: thisMonth.count,
      last30Days: last30Days.amount,
    },
    due: {
      next7Days: dueSoonOutstanding > 0n ? dueSoonOutstanding : 0n,
      next7DaysCount: dueSoon._count._all,
      overdueAmount: overdueOutstanding > 0n ? overdueOutstanding : 0n,
      overdueCount: overdue._count._all,
    },
    collectionByMonth,
    upcomingInstallments: upcomingInstallments.map((row) => ({
      id: row.id,
      serial: row.serial,
      installmentCount: row.investment.installmentCount,
      amount: row.amount,
      outstanding: row.amount - row.paidAmount,
      dueDate: row.dueDate,
      status: row.status,
      investor: { id: row.investment.investor.id, name: row.investment.investor.name, mobileMasked: true },
    })),
    recentPayments: recentPayments.map((row) => ({
      id: row.id,
      amount: row.amount,
      method: row.method,
      status: row.status,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      receiptNumber: row.receiptNumber,
      investorName: row.installment.investment.investor.name,
    })),
  }) as unknown as DashboardSummary;
}

/**
 * Monthly collection series. One grouped SQL query instead of 12 round trips;
 * the timezone conversion happens in the database so month buckets match Dhaka.
 */
export async function collectByMonth(months = 12): Promise<CollectionPoint[]> {
  const bounded = Math.min(Math.max(months, 1), 36);
  const from = addDhakaDays(startOfDhakaMonth(), -(bounded - 1) * 30); // generous lower bound
  const rows = await prisma.$queryRaw<Array<{ month: string; total: string; count: number }>>`
    SELECT to_char(date_trunc('month', ("completedAt" AT TIME ZONE 'Asia/Dhaka')), 'YYYY-MM') AS month,
           SUM(amount)::text AS total,
           COUNT(*)::int AS count
    FROM payments
    WHERE status = 'SUCCESS'
      AND "completedAt" IS NOT NULL
      AND "completedAt" >= ${from}
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((row) => ({ month: row.month, total: row.total, count: Number(row.count) }));
}

async function getUpcoming() {
  return prisma.installment.findMany({
    where: {
      status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
      investment: { status: 'ACTIVE' },
    },
    orderBy: { dueDate: 'asc' },
    take: 10,
    include: {
      investment: {
        select: { installmentCount: true, investor: { select: { id: true, name: true } } },
      },
    },
  });
}

async function getRecent() {
  return prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      installment: {
        select: {
          serial: true,
          investment: { select: { investor: { select: { name: true } } } },
        },
      },
    },
  });
}

export const dashboardService = { getSummary, collectByMonth };
export default dashboardService;
