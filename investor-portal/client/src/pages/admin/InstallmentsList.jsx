import { useState } from 'react';
import { Link } from 'react-router-dom';
import { installmentsApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Input, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDate, dueLabel } from '../../utils/format.js';

const PRESETS = [
  { key: 'open', label: 'Open', params: { openOnly: 'true' } },
  { key: 'overdue', label: 'Overdue', params: { openOnly: 'true', sort: 'due_date', dir: 'asc', dueTo: new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10) } },
  { key: 'due30', label: 'Due in 30 days', params: { openOnly: 'true' } },
  { key: 'paid', label: 'Paid', params: { status: 'PAID' } },
  { key: 'all', label: 'All', params: {} },
];

export function InstallmentsList() {
  const toast = useToast();
  const { atLeast } = useAuth();
  const [preset, setPreset] = useState('open');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);
  const debounced = useDebounce(search);

  const presetParams = PRESETS.find((p) => p.key === preset)?.params ?? {};
  const params = { ...presetParams, status: status || undefined, search: debounced, page, limit: 25 };

  const { data, loading, error, reload } = useApi(() => installmentsApi.list(params), [preset, status, debounced, page]);

  const toggle = (id) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  const bulkSend = async () => {
    if (!selected.length) return;
    try {
      const result = await installmentsApi.bulkSendLinks(selected);
      toast.success(`Sent ${result.sent} of ${result.requested} payment links`);
      setSelected([]);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Installments</h1>
        <div className="spacer" />
        {atLeast('ACCOUNTANT') && selected.length ? (
          <Button variant="primary" size="sm" onClick={bulkSend}>
            ✉ Send payment links ({selected.length})
          </Button>
        ) : null}
      </div>

      <Card>
        <div className="filters">
          {PRESETS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`btn sm ${preset === item.key ? 'primary' : ''}`}
              onClick={() => {
                setPreset(item.key);
                setPage(1);
              }}
            >
              {item.label}
            </button>
          ))}
          <div className="spacer" />
          <div className="field" style={{ minWidth: 220 }}>
            <Input value={search} onChange={setSearch} placeholder="Investor / installment #" />
          </div>
          <div className="field">
            <Select
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={[
                { value: '', label: 'Any status' },
                { value: 'PENDING', label: 'Pending' },
                { value: 'PARTIALLY_PAID', label: 'Partially paid' },
                { value: 'OVERDUE', label: 'Overdue' },
                { value: 'PAID', label: 'Paid' },
                { value: 'WAIVED', label: 'Waived' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
            />
          </div>
          <Button className="sm" onClick={reload}>
            ⟳
          </Button>
        </div>

        <Alert tone="error">{error?.message}</Alert>
        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              empty="No installments match these filters."
              columns={[
                ...(atLeast('ACCOUNTANT')
                  ? [
                      {
                        key: 'select',
                        header: '',
                        width: 34,
                        render: (row) => (
                          <input
                            type="checkbox"
                            checked={selected.includes(row.id)}
                            onChange={() => toggle(row.id)}
                            disabled={!['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status ?? row.status)}
                          />
                        ),
                      },
                    ]
                  : []),
                { key: 'investor', header: 'Investor', render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link> },
                { key: 'investment', header: 'Investment', render: (row) => <Link to={`/investments/${row.investment_id}`}>#{row.investment_id}</Link> },
                { key: 'serial', header: 'Inst.', render: (row) => `#${row.serial}` },
                { key: 'due_date', header: 'Due', render: (row) => <>{formatDate(row.due_date)} <span className="muted small">{dueLabel(row.due_date)}</span></> },
                { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
                { key: 'status', header: 'Status', render: (row) => <><Badge status={row.effective_status ?? row.status} /> {row.pay_link_active ? <span className="badge info">link</span> : null}</> },
                {
                  key: 'mobile',
                  header: 'Mobile',
                  render: (row) => <span className="mono">{row.investor_mobile_masked ?? row.investor_mobile}</span>,
                },
              ]}
            />
            <Pagination meta={data?.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <p className="muted small">
        Payment links are sent by SMS. Bulk sends are limited to 50 installments per request; the server also rate limits SMS.
      </p>
    </>
  );
}
