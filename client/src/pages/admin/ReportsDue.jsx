import { useState } from 'react';
import { Link } from 'react-router-dom';
import { reportsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Input, Kpi, Spinner, Table, Tabs } from '../../components/ui.jsx';
import { formatBDT, formatDate } from '../../utils/format.js';

export function ReportsDue() {
  const toast = useToast();
  const [tab, setTab] = useState('due');
  const [from, setFrom] = useState(() => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => {
    const date = new Date(Date.now() + 6 * 3600_000);
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString().slice(0, 10);
  });

  const due = useApi(() => reportsApi.due({ from, to }), [from, to]);
  const overdue = useApi(() => reportsApi.overdue(), []);

  const download = async () => {
    try {
      if (tab === 'due') await reportsApi.dueCsv({ from, to });
      else await reportsApi.overdueCsv({});
      toast.success('CSV downloaded');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Due & overdue</h1>
        <div className="spacer" />
        <Button className="sm" onClick={() => (tab === 'due' ? reportsApi.duePrint({ from, to }) : reportsApi.overduePrint({}))}>
          🖨 Printable
        </Button>
        <Button className="sm" onClick={download}>
          ⬇ CSV
        </Button>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'due', label: 'Installments due' },
          { key: 'overdue', label: 'Overdue' },
        ]}
      />

      {tab === 'due' ? (
        <>
          <div className="filters">
            <div className="field">
              <label htmlFor="from">From</label>
              <Input id="from" type="date" value={from} onChange={setFrom} />
            </div>
            <div className="field">
              <label htmlFor="to">To</label>
              <Input id="to" type="date" value={to} onChange={setTo} />
            </div>
          </div>

          <Alert tone="error">{due.error?.message}</Alert>
          {due.loading && !due.data ? (
            <Spinner />
          ) : (
            <>
              <div className="grid cols-3" style={{ marginBottom: 16 }}>
                <Kpi label="Installments in range" value={due.data?.summary?.count ?? 0} />
                <Kpi label="Amount due" value={formatBDT(due.data?.summary?.outstanding ?? 0, { compact: true })} tone="warn" />
                <Kpi
                  label="Already overdue in range"
                  value={formatBDT(due.data?.summary?.overdueAmount ?? 0, { compact: true })}
                  hint={`${due.data?.summary?.overdueCount ?? 0} installment(s)`}
                  tone="danger"
                />
              </div>
              <Card title="Installments due in the selected window">
                <Table
                  rows={due.data?.rows ?? []}
                  empty="Nothing due in this window."
                  columns={[
                    { key: 'investor', header: 'Investor', render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link> },
                    { key: 'mobile', header: 'Mobile', mono: true, render: (row) => row.investor_mobile },
                    { key: 'investment', header: 'Investment', render: (row) => <Link to={`/investments/${row.investment_id}`}>#{row.investment_id}</Link> },
                    { key: 'serial', header: 'Inst.', render: (row) => `#${row.serial}` },
                    { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
                    { key: 'due_date', header: 'Due', render: (row) => formatDate(row.due_date) },
                    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
                    {
                      key: 'days',
                      header: 'Days from today',
                      align: 'right',
                      render: (row) => (row.days_from_today > 0 ? <span style={{ color: 'var(--danger)' }}>{row.days_from_today} late</span> : row.days_from_today * -1),
                    },
                  ]}
                  footer={
                    due.data
                      ? [
                          <td key="l">Total outstanding</td>,
                          <td key="a" className="num" colSpan={8}>
                            {formatBDT(due.data.summary.outstanding)}
                          </td>,
                        ]
                      : null
                  }
                />
              </Card>
            </>
          )}
        </>
      ) : (
        <>
          <Alert tone="error">{overdue.error?.message}</Alert>
          {overdue.loading && !overdue.data ? (
            <Spinner />
          ) : (
            <>
              <div className="grid cols-4" style={{ marginBottom: 16 }}>
                <Kpi label="Overdue installments" value={overdue.data?.summary?.count ?? 0} tone="danger" />
                <Kpi label="Overdue amount" value={formatBDT(overdue.data?.summary?.outstanding ?? 0, { compact: true })} tone="danger" />
                <Kpi label="1–15 days" value={formatBDT(overdue.data?.summary?.buckets?.['1-15'] ?? 0, { compact: true })} />
                <Kpi label="16–30 days" value={formatBDT(overdue.data?.summary?.buckets?.['16-30'] ?? 0, { compact: true })} />
              </div>
              <Card title={`Overdue as of ${overdue.data?.summary?.asOf ?? ''}`}>
                <Table
                  rows={overdue.data?.rows ?? []}
                  empty="No overdue installments."
                  columns={[
                    { key: 'investor', header: 'Investor', render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link> },
                    { key: 'mobile', header: 'Mobile', mono: true, render: (row) => row.investor_mobile },
                    { key: 'investment', header: 'Investment', render: (row) => <Link to={`/investments/${row.investment_id}`}>#{row.investment_id}</Link> },
                    { key: 'serial', header: 'Inst.', render: (row) => `#${row.serial}` },
                    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
                    { key: 'due_date', header: 'Due', render: (row) => formatDate(row.due_date) },
                    { key: 'days_overdue', header: 'Days late', align: 'right' },
                    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
                  ]}
                  footer={
                    overdue.data
                      ? [
                          <td key="l">Total overdue</td>,
                          <td key="a" className="num" colSpan={7}>
                            {formatBDT(overdue.data.summary.outstanding)}
                          </td>,
                        ]
                      : null
                  }
                />
              </Card>
              <p className="muted small">
                Overdue reminders are sent automatically every {`{OVERDUE_REMINDER_INTERVAL_HOURS}`} hours (default 72) by the in-process
                scheduler; each send is recorded in the SMS log.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
