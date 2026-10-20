/**
 * Staff inquiry inbox. Mirrors the investor's in-app support view: the same
 * tickets, the same conversation, with staff-only status controls.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supportApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Button, Card, Field, Input, Kpi, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { TicketChat, TICKET_CATEGORIES, TICKET_STATUSES, TicketStatusBadge } from '../../components/TicketChat.jsx';
import { formatDateTime } from '../../utils/format.js';

export function SupportInbox() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search);
  const selectedId = searchParams.get('ticket');

  const summary = useApi(() => supportApi.summary(), []);
  const list = useApi(
    () => supportApi.list({ status: status || undefined, category: category || undefined, search: debouncedSearch || undefined, page, limit: 20 }),
    [status, category, debouncedSearch, page],
  );
  const detail = useApi(() => (selectedId ? supportApi.get(selectedId) : Promise.resolve(null)), [selectedId]);

  const rows = list.data?.items ?? [];
  const meta = list.data?.meta;

  const openTicket = (id) => {
    const next = new URLSearchParams(searchParams);
    next.set('ticket', String(id));
    setSearchParams(next);
  };

  const refresh = () => {
    list.reload();
    detail.reload();
    summary.reload();
  };

  const reply = async (body, options) => {
    const result = await supportApi.reply(selectedId, { message: body, status: options?.status });
    detail.setData(result);
    toast.success('Reply sent to the investor');
  };

  const setStatusFor = async (next) => {
    try {
      const result = await supportApi.setStatus(selectedId, { status: next, note: next === 'RESOLVED' ? 'Marked resolved by the office.' : undefined });
      detail.setData(result);
      toast.success(`Inquiry ${next.toLowerCase()}`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Support inquiries</h1>
          <p className="muted">Messages from the investor portal land here. Replies appear instantly in the member’s portal.</p>
        </div>
        <div className="spacer" />
        <Button className="sm" onClick={refresh}>Refresh</Button>
      </div>

      <div className="kpi-grid">
        <Kpi label="Open & in progress" value={summary.data?.open_tickets ?? '—'} tone={summary.data?.open_tickets ? 'warn' : ''} hint="Awaiting an office reply" />
        <Kpi label="Wallet requests" value={summary.data?.pending_wallet_requests ?? '—'} hint="Pending deposits / withdrawals" />
        <Kpi label="In this queue" value={meta?.total ?? '—'} hint={status ? `Filtered: ${status.toLowerCase()}` : 'All statuses'} />
      </div>

      <Card title="Filters">
        <div className="form-row">
          <Field label="Status">
            <Select value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: '', label: 'All statuses' }, ...TICKET_STATUSES]} />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(value) => { setCategory(value); setPage(1); }} options={[{ value: '', label: 'All categories' }, ...TICKET_CATEGORIES]} />
          </Field>
          <Field label="Search">
            <Input value={search} onChange={(value) => { setSearch(value); setPage(1); }} placeholder="Ticket no, subject or investor" />
          </Field>
        </div>
      </Card>

      <div className="grid cols-2 support-grid">
        <Card title="Inbox">
          {list.loading ? (
            <Spinner />
          ) : (
            <>
              <Table
                rows={rows}
                empty="No inquiries match these filters."
                onRowClick={(row) => openTicket(row.id)}
                rowClassName={(row) => (String(row.id) === String(selectedId) ? 'selected' : '')}
                columns={[
                  {
                    key: 'subject',
                    header: 'Inquiry',
                    render: (row) => (
                      <div>
                        <strong>{row.subject}</strong>
                        <div className="small muted mono">{row.ticket_no} · {row.investor_name}</div>
                      </div>
                    ),
                  },
                  { key: 'category_label', header: 'Category', render: (row) => row.category_label ?? row.category },
                  { key: 'status', header: 'Status', render: (row) => <TicketStatusBadge status={row.status} label={row.status_label} /> },
                  { key: 'last_message_at', header: 'Last activity', render: (row) => <span className="small">{formatDateTime(row.last_message_at)}</span> },
                  {
                    key: 'open',
                    header: '',
                    align: 'right',
                    render: (row) => (
                      <Button className="sm ghost" onClick={(event) => { event.stopPropagation(); openTicket(row.id); }}>Open</Button>
                    ),
                  },
                ]}
              />
              {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
            </>
          )}
        </Card>

        <Card title="Conversation">
          {!selectedId ? (
            <div className="empty">Pick an inquiry from the list to read and reply.</div>
          ) : detail.loading && !detail.data ? (
            <Spinner />
          ) : (
            <>
              {detail.data?.ticket?.investor_name ? (
                <div className="inline" style={{ marginBottom: 8 }}>
                  <Button
                    className="sm ghost"
                    onClick={() => navigate(`/investors/${detail.data.ticket.investor_id}`)}
                  >
                    Open investor profile →
                  </Button>
                  <div className="spacer" />
                </div>
              ) : null}
              <TicketChat
                mode="admin"
                ticket={detail.data?.ticket}
                messages={detail.data?.messages ?? []}
                loading={detail.loading}
                onReply={reply}
                onStatus={setStatusFor}
                onReload={refresh}
              />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
