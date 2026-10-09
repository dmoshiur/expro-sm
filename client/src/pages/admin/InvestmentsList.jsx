import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { investmentsApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Badge, Button, Card, Input, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { Alert } from '../../components/ui.jsx';
import { formatBDT, formatDate } from '../../utils/format.js';

export function InvestmentsList() {
  const navigate = useNavigate();
  const { atLeast } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [hasOverdue, setHasOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search);

  const { data, loading, error } = useApi(
    () => investmentsApi.list({ search: debounced, status, hasOverdue: hasOverdue ? 'true' : '', page, limit: 25 }),
    [debounced, status, hasOverdue, page],
  );

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Investments</h1>
        <div className="spacer" />
        {atLeast('ACCOUNTANT') ? (
          <Button variant="primary" size="sm" onClick={() => navigate('/investments/new')}>
            + New investment
          </Button>
        ) : null}
      </div>

      <Card>
        <div className="filters">
          <div className="field" style={{ minWidth: 260 }}>
            <label htmlFor="search">Search</label>
            <Input id="search" value={search} onChange={setSearch} placeholder="Investor name, mobile, investment #" />
          </div>
          <div className="field">
            <label htmlFor="status">Status</label>
            <Select
              id="status"
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={[
                { value: '', label: 'All' },
                { value: 'ACTIVE', label: 'Active' },
                { value: 'COMPLETED', label: 'Completed' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
            />
          </div>
          <div className="field">
            <label htmlFor="overdue">&nbsp;</label>
            <label className="inline small">
              <input type="checkbox" checked={hasOverdue} onChange={(e) => setHasOverdue(e.target.checked)} /> Overdue only
            </label>
          </div>
        </div>

        <Alert tone="error">{error?.message}</Alert>
        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              empty="No investments match these filters."
              columns={[
                { key: 'id', header: '#', render: (row) => <Link to={`/investments/${row.id}`} style={{ fontWeight: 600 }}>#{row.id}</Link> },
                { key: 'investor', header: 'Investor', render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link> },
                { key: 'title', header: 'Title', render: (row) => row.title || '—' },
                { key: 'total_amount', header: 'Total', align: 'right', render: (row) => formatBDT(row.total_amount) },
                {
                  key: 'progress',
                  header: 'Collected',
                  align: 'right',
                  render: (row) => (
                    <span>
                      {formatBDT(row.amount_collected)}
                      <span className="muted small"> / {row.installment_count} inst.</span>
                    </span>
                  ),
                },
                { key: 'amount_outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.amount_outstanding) },
                { key: 'next_due_date', header: 'Next due', render: (row) => (row.next_due_date ? formatDate(row.next_due_date) : '—') },
                { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
              ]}
            />
            <Pagination meta={data?.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
