/**
 * Staff view of donations (read-only). Shows the investor name and receipt,
 * never a mobile number. Donations are created and settled by the portal and
 * the gateway callback, so staff cannot edit them here.
 */
import { useState } from 'react';
import { donationsApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { Alert, Badge, Card, Input, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDateTime } from '../../utils/format.js';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'SUCCESS', label: 'Success' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'INITIATED', label: 'Initiated' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const FUND_OPTIONS = [
  { value: '', label: 'All funds' },
  { value: 'WELFARE', label: 'General welfare fund' },
  { value: 'EDUCATION', label: 'Education support' },
  { value: 'MEDICAL', label: 'Medical assistance' },
  { value: 'COMMUNITY', label: 'Community project' },
];

export function DonationsList() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [fund, setFund] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search);
  const limit = 25;
  const offset = (page - 1) * limit;

  const { data, loading, error } = useApi(
    () => donationsApi.list({ search: debounced, status, fund, limit, offset }),
    [debounced, status, fund, page],
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Donations</h1>
          <p className="muted">Welfare donations from investors. Read-only: records come from the gateway.</p>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <Card>
          <div className="small muted">Successful donations (this filter)</div>
          <div className="text-2xl font-extrabold">{formatBDT(data?.successAmount ?? 0)}</div>
        </Card>
        <Card>
          <div className="small muted">Records (this filter)</div>
          <div className="text-2xl font-extrabold">{total}</div>
        </Card>
        <Card>
          <div className="small muted">Mobile numbers</div>
          <div className="small" style={{ marginTop: 6 }}>Not shown in this list. Open the investor record to view contact details.</div>
        </Card>
      </div>

      <Card>
        <div className="filters" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ flex: '1 1 220px' }}>
            <Input
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              placeholder="Search investor, transaction ID or donation #"
              aria-label="Search donations"
            />
          </div>
          <div style={{ flex: '0 1 180px' }}>
            <Select
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_OPTIONS}
              aria-label="Status"
            />
          </div>
          <div style={{ flex: '0 1 200px' }}>
            <Select
              value={fund}
              onChange={(value) => {
                setFund(value);
                setPage(1);
              }}
              options={FUND_OPTIONS}
              aria-label="Fund"
            />
          </div>
        </div>

        {error ? <Alert tone="error">{error.message}</Alert> : null}
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table
            rows={rows}
            empty="No donations match these filters."
            columns={[
              { key: 'created_at', header: 'Date', render: (row) => formatDateTime(row.paid_at ?? row.created_at) },
              { key: 'receipt_number', header: 'Receipt', mono: true, render: (row) => row.receipt_number },
              {
                key: 'investor',
                header: 'Investor',
                render: (row) => (
                  <>
                    <strong>{row.investor?.name}</strong>
                    <div className="small muted mono">{row.investor?.member_code}</div>
                  </>
                ),
              },
              { key: 'fund_name', header: 'Fund' },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
              { key: 'trx_id', header: 'Trx ID', mono: true, render: (row) => row.trx_id ?? '—' },
            ]}
          />
        )}
        {total > limit ? <Pagination meta={{ page, pages: Math.ceil(total / limit), total }} onPage={setPage} /> : null}
      </Card>
    </>
  );
}
