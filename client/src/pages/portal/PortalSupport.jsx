/**
 * In-app support: the member opens an inquiry, chats with the office in real
 * time and closes it when resolved. The staff inbox reads the same records.
 */
import { useState } from 'react';
import { portalApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Button, Card, Field, Input, Modal, Select, Spinner, Table } from '../../components/ui.jsx';
import { TicketChat, TICKET_CATEGORIES, TicketStatusBadge } from '../../components/TicketChat.jsx';
import { formatDateTime } from '../../utils/format.js';

const PRIORITIES = [
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'High' },
  { value: 'URGENT', label: 'Urgent' },
];

export function PortalSupport() {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = useApi(() => portalApi.tickets(), []);
  const detail = useApi(() => (selectedId ? portalApi.ticket(selectedId) : Promise.resolve(null)), [selectedId]);

  const tickets = list.data?.tickets ?? [];
  const refresh = () => {
    list.reload();
    if (selectedId) detail.reload();
  };

  const openTicket = (id) => {
    if (selectedId === id) return;
    setSelectedId(id);
  };

  const reply = async (body) => {
    const result = await portalApi.replyTicket(selectedId, { message: body });
    detail.setData(result);
    list.reload();
  };

  const closeTicket = async () => {
    try {
      const result = await portalApi.closeTicket(selectedId);
      detail.setData(result);
      toast.success('Inquiry closed. Thank you!');
      list.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const created = async () => {
    setCreating(false);
    toast.success('Inquiry sent - the office has been notified');
    const next = await list.reload();
    const newest = next?.tickets?.[0];
    if (newest) setSelectedId(newest.id);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Support & inquiries</h1>
          <p className="muted">Ask the office about payments, pension installments, wallet requests, documents or your profile.</p>
        </div>
        <div className="spacer" />
        <Button className="sm primary" onClick={() => setCreating(true)}>+ New inquiry</Button>
      </div>

      <div className="grid cols-2 support-grid">
        <Card title="My inquiries" actions={<span className="small muted">{tickets.length}</span>}>
          {list.loading ? (
            <Spinner />
          ) : (
            <Table
              rows={tickets}
              empty="No inquiries yet. Start one with “+ New inquiry”."
              onRowClick={(row) => openTicket(row.id)}
              rowClassName={(row) => (row.id === selectedId ? 'selected' : '')}
              columns={[
                {
                  key: 'subject',
                  header: 'Inquiry',
                  render: (row) => (
                    <div>
                      <strong>{row.subject}</strong>
                      <div className="small muted mono">{row.ticket_no} · {row.message_count} message(s)</div>
                    </div>
                  ),
                },
                { key: 'status', header: 'Status', render: (row) => <TicketStatusBadge status={row.status} label={row.status_label} /> },
                {
                  key: 'last_message_at',
                  header: 'Updated',
                  render: (row) => <span className="small">{formatDateTime(row.last_message_at)}</span>,
                },
              ]}
            />
          )}
        </Card>

        <Card title="Conversation">
          {!selectedId ? (
            <div className="empty">Pick an inquiry on the left, or start a new one.</div>
          ) : detail.loading && !detail.data ? (
            <Spinner />
          ) : (
            <TicketChat
              mode="investor"
              ticket={detail.data?.ticket}
              messages={detail.data?.messages ?? []}
              loading={detail.loading}
              onReply={reply}
              onClose={closeTicket}
              onReload={refresh}
            />
          )}
        </Card>
      </div>

      {creating ? <NewTicketModal onClose={() => setCreating(false)} onCreated={created} /> : null}
    </>
  );
}

function NewTicketModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ subject: '', category: 'GENERAL', priority: 'NORMAL', message: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (form.subject.trim().length < 3) nextErrors.subject = 'Give the inquiry a short subject';
    if (!form.message.trim()) nextErrors.message = 'Describe what you need help with';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await portalApi.createTicket({
        subject: form.subject.trim(),
        category: form.category,
        priority: form.priority,
        message: form.message.trim(),
      });
      await onCreated();
    } catch (err) {
      setErrors(err.details ?? { form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New inquiry" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted">The office sees this immediately and replies in the same thread.</p>
        {errors.form ? <div className="alert error">{errors.form}</div> : null}
        <Field label="Subject" error={errors.subject}>
          <Input
            value={form.subject}
            onChange={(value) => setForm((current) => ({ ...current, subject: value }))}
            placeholder="e.g. Wallet withdrawal not received"
            maxLength={160}
            autoFocus
          />
        </Field>
        <div className="form-row">
          <Field label="Category" error={errors.category}>
            <Select value={form.category} onChange={(value) => setForm((current) => ({ ...current, category: value }))} options={TICKET_CATEGORIES} />
          </Field>
          <Field label="Priority" error={errors.priority}>
            <Select value={form.priority} onChange={(value) => setForm((current) => ({ ...current, priority: value }))} options={PRIORITIES} />
          </Field>
        </div>
        <Field label="Message" error={errors.message}>
          <textarea
            value={form.message}
            onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))}
            rows={5}
            maxLength={4000}
            placeholder="Tell us what happened, with dates and amounts if relevant…"
          />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Sending…' : 'Send inquiry'}</Button>
        </div>
      </form>
    </Modal>
  );
}
