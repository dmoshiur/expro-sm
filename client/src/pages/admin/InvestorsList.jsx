import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { investorsApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Input, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDate, maskMobile } from '../../utils/format.js';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'CLOSED', label: 'Closed' },
];

export function InvestorsList() {
  const { atLeast, isSuperAdmin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('created_at');
  const [dir, setDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const debouncedSearch = useDebounce(search);

  const params = { search: debouncedSearch, status, sort, dir, page, limit: 25, includeDeleted: includeDeleted ? 'true' : '' };
  const { data, loading, error, reload } = useApi(() => investorsApi.list(params), [debouncedSearch, status, sort, dir, page, includeDeleted]);

  const onSort = (column) => {
    if (sort === column) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(column);
      setDir('asc');
    }
  };

  const exportCsv = async () => {
    try {
      await investorsApi.exportCsv({ search: debouncedSearch, status, limit: 100 });
      toast.success('CSV downloaded');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Investors</h1>
        <div className="spacer" />
        <Button className="sm" onClick={exportCsv}>
          ⬇ Export CSV
        </Button>
        {atLeast('ACCOUNTANT') ? (
          <Button variant="primary" size="sm" onClick={() => navigate('/investors/new')}>
            + New investor
          </Button>
        ) : null}
      </div>

      <Card>
        <div className="filters">
          <div className="field" style={{ minWidth: 260 }}>
            <label htmlFor="search">Search</label>
            <Input id="search" value={search} onChange={setSearch} placeholder="Name, mobile or address" />
          </div>
          <div className="field">
            <label htmlFor="status">Status</label>
            <Select id="status" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={STATUS_OPTIONS} />
          </div>
          {isSuperAdmin ? (
            <div className="field">
              <label htmlFor="deleted">Deleted</label>
              <Select
                id="deleted"
                value={includeDeleted ? 'yes' : 'no'}
                onChange={(value) => setIncludeDeleted(value === 'yes')}
                options={[
                  { value: 'no', label: 'Hide deleted' },
                  { value: 'yes', label: 'Include deleted' },
                ]}
              />
            </div>
          ) : null}
          <div className="spacer" />
          <Button className="sm" onClick={reload}>
            ⟳
          </Button>
        </div>

        <Alert tone="error">{error?.message}</Alert>
        {loading && !data ? <Spinner /> : (
          <>
            <Table
              rows={data?.items ?? []}
              empty="No investors match these filters."
              columns={[
                {
                  key: 'name',
                  header: <span role="button" onClick={() => onSort('name')}>Name {sort === 'name' ? (dir === 'asc' ? '↑' : '↓') : ''}</span>,
                  render: (row) => (
                    <Link to={`/investors/${row.id}`} style={{ fontWeight: 600 }}>
                      {row.name}
                    </Link>
                  ),
                },
                {
                  key: 'mobile',
                  header: <span role="button" onClick={() => onSort('mobile')}>Mobile</span>,
                  render: (row) => <span className="mono">{row.mobile}</span>,
                },
                { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
                { key: 'nominee_count', header: 'Nominees', align: 'right' },
                { key: 'investment_count', header: 'Investments', align: 'right' },
                { key: 'total_invested', header: 'Invested', align: 'right', render: (row) => formatBDT(row.total_invested) },
                { key: 'total_collected', header: 'Collected', align: 'right', render: (row) => formatBDT(row.total_collected) },
                {
                  key: 'created_at',
                  header: <span role="button" onClick={() => onSort('created_at')}>Created</span>,
                  render: (row) => formatDate(row.created_at),
                },
              ]}
            />
            <Pagination meta={data?.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export { maskMobile };
