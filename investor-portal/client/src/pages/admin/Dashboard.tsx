import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dashboardService } from '@/services/report.service';
import { bdt, formatDate } from '@/lib/format';
import { Alert, EmptyState, Loading, Money, StatCard, StatusBadge } from '@/components/ui';

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ['dashboard'], queryFn: () => dashboardService.summary(12) });

  if (isLoading) return <Loading label="Loading dashboard…" />;
  if (error || !data) return <Alert kind="error">Could not load the dashboard. Please refresh.</Alert>;

  const chartData = data.collectionByMonth.map((point) => ({
    month: point.month,
    amount: Number(point.total) / 100,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500">Live collection position across all active investments.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total invested" value={<Money poisha={data.totals.invested} />} hint={`${data.counts.investments} investments · ${data.counts.investors} investors`} />
        <StatCard label="Collected" value={<Money poisha={data.totals.collected} />} tone="success" hint={`${data.counts.paidInstallments} of ${data.counts.installments} installments paid`} />
        <StatCard label="Outstanding" value={<Money poisha={data.totals.outstanding} />} tone="brand" hint={`Waived ${bdt(data.totals.waived)}`} />
        <StatCard label="Overdue" value={<Money poisha={data.totals.overdue} />} tone="danger" hint={`${data.counts.overdueInstallments} installment(s)`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <StatCard label="Collected today" value={<Money poisha={data.collection.today} />} hint={`${data.collection.todayCount} payment(s) · yesterday ${bdt(data.collection.yesterday)}`} />
        <StatCard label="This month" value={<Money poisha={data.collection.thisMonth} />} hint={`${data.collection.thisMonthCount} payment(s) · 30d ${bdt(data.collection.last30Days)}`} />
        <StatCard label="Due in next 7 days" value={<Money poisha={data.due.next7Days} />} hint={`${data.due.next7DaysCount} installment(s)`} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Collection by month</h2>
          <span className="text-xs text-slate-500">BDT, last 12 months</span>
        </div>
        <div className="card-body h-72">
          {chartData.length === 0 ? (
            <EmptyState title="No collections yet" description="Payments recorded through bKash or manual entry will appear here." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(value: number) => `${Math.round(value / 1000)}k`} />
                <Tooltip formatter={(value: number) => bdt(value * 100)} />
                <Bar dataKey="amount" fill="#2559eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Upcoming & overdue installments</h2>
            <Link to="/reports/due" className="link text-sm">
              Full report
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Investor</th>
                  <th className="th">Installment</th>
                  <th className="th">Due</th>
                  <th className="th text-right">Outstanding</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.upcomingInstallments.length === 0 ? (
                  <tr>
                    <td className="td text-slate-500" colSpan={5}>
                      Nothing pending. 🎉
                    </td>
                  </tr>
                ) : (
                  data.upcomingInstallments.map((row) => (
                    <tr key={row.id}>
                      <td className="td">
                        <Link to={`/investors/${row.investor.id}`} className="link">
                          {row.investor.name}
                        </Link>
                      </td>
                      <td className="td">
                        {row.serial}/{row.installmentCount}
                      </td>
                      <td className="td">{formatDate(row.dueDate)}</td>
                      <td className="td text-right">
                        <Money poisha={row.outstanding} />
                      </td>
                      <td className="td">
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Recent payments</h2>
            <Link to="/payments" className="link text-sm">
              All payments
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Investor</th>
                  <th className="th">Method</th>
                  <th className="th">When</th>
                  <th className="th text-right">Amount</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recentPayments.length === 0 ? (
                  <tr>
                    <td className="td text-slate-500" colSpan={5}>
                      No payments recorded yet.
                    </td>
                  </tr>
                ) : (
                  data.recentPayments.map((row) => (
                    <tr key={row.id}>
                      <td className="td">{row.investorName}</td>
                      <td className="td">{row.method}</td>
                      <td className="td">{formatDate(row.completedAt ?? row.createdAt)}</td>
                      <td className="td text-right">
                        <Money poisha={row.amount} />
                      </td>
                      <td className="td">
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
