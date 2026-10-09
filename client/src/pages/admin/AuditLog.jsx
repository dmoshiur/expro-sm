import { useState } from 'react';
import { auditApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { Alert, Button, Card, Input, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

export function AuditLog() {
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const debounced = useDebounce(search);

  const filters = useApi(() => auditApi.filters(), []);
  const { data, loading, error } = useApi(
    () => auditApi.list({ action, entity, search: debounced, from, to, page, limit: 50 }),
    [action, entity, debounced, from, to, page],
  );

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Audit log</h1>
        <span className="badge muted">append-only</span>
        <div className="spacer" />
        <span className="muted small">Every create, update, delete, login, payment and link action is recorded here.</span>
      </div>

      <Card>
        <div className="filters">
          <div className="field">
            <label htmlFor="action">Action</label>
            <Select
              id="action"
              value={action}
              onChange={(value) => { setAction(value); setPage(1); }}
              options={[{ value: '', label: 'All actions' }, ...(filters.data?.actions ?? []).map((a) => ({ value: a, label: a }))]}
            />
          </div>
          <div className="field">
            <label htmlFor="entity">Entity</label>
            <Select
              id="entity"
              value={entity}
              onChange={(value) => { setEntity(value); setPage(1); }}
              options={[{ value: '', label: 'All entities' }, ...(filters.data?.entities ?? []).map((e) => ({ value: e, label: e }))]}
            />
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor="search">Search</label>
            <Input id="search" value={search} onChange={setSearch} placeholder="Actor, action or entity" />
          </div>
          <div className="field">
            <label htmlFor="from">From</label>
            <Input id="from" type="date" value={from} onChange={setFrom} />
          </div>
          <div className="field">
            <label htmlFor="to">To</label>
            <Input id="to" type="date" value={to} onChange={setTo} />
          </div>
        </div>

        <Alert tone="error">{error?.message}</Alert>
        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              empty="No audit entries for these filters."
              columns={[
                { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
                { key: 'actor', header: 'Actor', render: (row) => row.actor_email ?? 'system' },
                { key: 'action', header: 'Action', render: (row) => <span className="badge info">{row.action}</span> },
                { key: 'entity', header: 'Entity', render: (row) => `${row.entity}${row.entity_id ? ` #${row.entity_id}` : ''}` },
                { key: 'ip', header: 'IP', mono: true, render: (row) => row.ip ?? '—' },
                { key: 'request_id', header: 'Request', mono: true, render: (row) => (row.request_id ? row.request_id.slice(0, 8) : '—') },
                {
                  key: 'detail',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <Button className="sm ghost" onClick={() => setDetail(row)}>
                      Details
                    </Button>
                  ),
                },
              ]}
            />
            <Pagination meta={data?.meta} onPage={setPage} />
          </>
        )}
      </Card>

      {detail ? (
        <Card title={`${detail.action} · ${detail.entity}${detail.entity_id ? ` #${detail.entity_id}` : ''}`} actions={<Button className="sm" onClick={() => setDetail(null)}>Close</Button>}>
          <div className="small muted" style={{ marginBottom: 10 }}>
            {detail.actor_email ?? 'system'} · {formatDateTime(detail.created_at)} · IP {detail.ip ?? '—'}
          </div>
          <div className="grid cols-2">
            <div>
              <h3>Before</h3>
              <pre className="code-box" style={{ maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(detail.old_value, null, 2) ?? '—'}</pre>
            </div>
            <div>
              <h3>After</h3>
              <pre className="code-box" style={{ maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(detail.new_value, null, 2) ?? '—'}</pre>
            </div>
          </div>
          {detail.meta ? (
            <>
              <h3 style={{ marginTop: 12 }}>Context</h3>
              <pre className="code-box" style={{ maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(detail.meta, null, 2)}</pre>
            </>
          ) : null}
          <p className="muted small" style={{ marginTop: 10 }}>
            Sensitive values (passwords, tokens, NID, scans) are redacted before they are written.
          </p>
        </Card>
      ) : null}
    </>
  );
}
