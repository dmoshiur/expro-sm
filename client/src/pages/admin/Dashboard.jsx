import { Link } from 'react-router-dom';
import { dashboardApi, jobsApi, supportApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Badge, Banner, Card, Kpi, Spinner, Table } from '../../components/ui.jsx';
import { BarChart, Donut } from '../../components/Charts.jsx';
import { formatBDT, formatDate, formatDateTime, formatNumber, dueLabel, maskMobile } from '../../utils/format.js';

export function Dashboard() {
  const { admin } = useAuth();
  const { data, loading, error, reload } = useApi(() => dashboardApi.summary(), []);
  const isSuperAdmin = admin?.role === 'SUPER_ADMIN';
  const jobs = useApi(() => (isSuperAdmin ? jobsApi.status() : Promise.resolve(null)), [isSuperAdmin]);
  const support = useApi(() => supportApi.summary(), []);

  if (loading) return <Spinner label="Loading dashboard…" />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  if (!data) return null;

  const { kpis, collectionsByMonth, installmentsByStatus, upcomingDue, overdue, recentPayments } = data;

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <div className="spacer" />
        <span className="muted small">Today ({data.today}, Asia/Dhaka)</span>
        <button className="btn sm" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>

      {kpis.overdueCount > 0 || support.data?.open_tickets > 0 || support.data?.pending_wallet_requests > 0 ? (
        <div className="banners" style={{ marginBottom: 14 }}>
          {kpis.overdueCount > 0 ? (
            <Banner
              tone="danger"
              title={`${kpis.overdueCount} overdue installment${kpis.overdueCount === 1 ? '' : 's'} · ${formatBDT(kpis.overdueAmount)}`}
              action={<Link className="btn sm" to="/reports/due">Chase list</Link>}
            >
              These members have missed due dates. Send payment links from the chase list or record a manual payment.
            </Banner>
          ) : null}
          {kpis.upcomingDueCount > 0 ? (
            <Banner
              tone="warn"
              title={`Due in the next 7 days: ${formatBDT(kpis.upcomingDueAmount)}`}
              action={<Link className="btn sm" to="/reports/due">See who</Link>}
            >
              {kpis.upcomingDueCount} installment{kpis.upcomingDueCount === 1 ? '' : 's'} fall due this week.
            </Banner>
          ) : null}
          {support.data?.pending_wallet_requests > 0 ? (
            <Banner
              tone="info"
              title={`${support.data.pending_wallet_requests} wallet request${support.data.pending_wallet_requests === 1 ? '' : 's'} awaiting approval`}
              action={<Link className="btn sm" to="/support">Review</Link>}
            >
              Deposit and withdrawal requests from the investor portal reduce available balances until they are approved or rejected.
            </Banner>
          ) : null}
          {support.data?.open_tickets > 0 ? (
            <Banner
              tone="info"
              title={`${support.data.open_tickets} open support inquir${support.data.open_tickets === 1 ? 'y' : 'ies'}`}
              action={<Link className="btn sm" to="/support">Open inbox</Link>}
            >
              Members are waiting for a reply in the investor portal.
            </Banner>
          ) : null}
        </div>
      ) : null}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Kpi label="Total invested" value={formatBDT(kpis.totalInvested, { compact: true })} hint={`${formatNumber(kpis.investmentCount)} investments`} />
        <Kpi label="Total collected" value={formatBDT(kpis.totalCollected, { compact: true })} hint={`${kpis.collectionRate}% of invested`} tone="ok" />
        <Kpi label="Today's collection" value={formatBDT(kpis.todayCollection, { compact: true })} hint={`${kpis.todayPaymentCount} payment(s) today`} />
        <Kpi label="Outstanding" value={formatBDT(kpis.totalOutstanding, { compact: true })} hint="open installments" />
        <Kpi label="Overdue" value={formatBDT(kpis.overdueAmount, { compact: true })} hint={`${kpis.overdueCount} installment(s)`} tone={kpis.overdueCount ? 'danger' : ''} />
        <Kpi label="Due next 7 days" value={formatBDT(kpis.upcomingDueAmount, { compact: true })} hint={`${kpis.upcomingDueCount} installment(s)`} tone="warn" />
        <Kpi label="This month" value={formatBDT(kpis.monthCollection, { compact: true })} hint="collected" />
        <Kpi label="Investors" value={formatNumber(kpis.investorCount)} hint={`${kpis.activeInvestorCount} active`} />
      </div>

      <div className="grid cols-2">
        <Card title="Collection by month (last 12 months)">
          <BarChart data={collectionsByMonth} format={(value) => formatBDT(value, { compact: true })} />
        </Card>
        <Card title="Installments by status">
          <Donut
            data={installmentsByStatus.map((row) => ({
              label: `${row.status} (${row.count})`,
              value: Number(row.amount),
              formatted: formatBDT(row.amount, { compact: true }),
            }))}
          />
        </Card>
      </div>

      <div className="grid cols-2">
        <Card
          title="Upcoming due"
          actions={
            <Link className="btn sm" to="/reports/due">
              Open report
            </Link>
          }
        >
          <Table
            rows={upcomingDue}
            empty="Nothing due soon."
            columns={[
              {
                key: 'investor',
                header: 'Investor',
                render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link>,
              },
              { key: 'installment', header: '#', render: (row) => `#${row.serial}` },
              { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
              {
                key: 'due_date',
                header: 'Due',
                render: (row) => (
                  <>
                    {formatDate(row.due_date)} <span className="muted small">{dueLabel(row.due_date)}</span>
                  </>
                ),
              },
            ]}
          />
        </Card>

        <Card
          title="Overdue"
          actions={
            <Link className="btn sm" to="/reports/due">
              Chase list
            </Link>
          }
        >
          <Table
            rows={overdue}
            empty="No overdue installments. 🎉"
            columns={[
              {
                key: 'investor',
                header: 'Investor',
                render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link>,
              },
              { key: 'mobile', header: 'Mobile', render: (row) => <span className="mono">{maskMobile(row.investor_mobile)}</span> },
              { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
              { key: 'due_date', header: 'Due', render: (row) => <span className="badge danger">{dueLabel(row.due_date)}</span> },
            ]}
          />
        </Card>
      </div>

      <Card
        title="Recent payments"
        actions={
          <Link className="btn sm" to="/payments">
            All payments
          </Link>
        }
      >
        <Table
          rows={recentPayments}
          empty="No payments yet."
          columns={[
            { key: 'id', header: 'ID', render: (row) => `#${row.id}` },
            { key: 'investor', header: 'Investor', render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link> },
            { key: 'installment', header: 'Installment', render: (row) => `#${row.installment_serial}` },
            { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
            { key: 'method', header: 'Method', render: (row) => <span className="badge muted">{row.method}</span> },
            { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
            { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
          ]}
        />
      </Card>

      {isSuperAdmin ? (
        <Card
          title="Background jobs"
          actions={
            <Link className="btn sm" to="/system">
              Run / inspect
            </Link>
          }
        >
          <Table
            rows={jobs.data?.jobs ?? []}
            empty="Scheduler is not running."
            keyField="name"
            columns={[
              { key: 'name', header: 'Job' },
              { key: 'description', header: 'What it does' },
              { key: 'schedule', header: 'Schedule', render: (row) => (row.schedule.type === 'daily' ? `daily ${row.schedule.at} Asia/Dhaka` : `every ${row.schedule.everyMinutes} min`) },
              { key: 'runKey', header: 'Current key', mono: true },
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}
