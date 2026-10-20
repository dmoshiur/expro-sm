/**
 * Conversation pane shared by the staff inbox and the investor portal.
 *
 * The parent owns the API calls so the same markup works with either session:
 * staff can pick the next status while replying, investors can only reply or
 * close their own ticket.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Spinner } from './ui.jsx';
import { formatDateTime } from '../utils/format.js';

export const TICKET_STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
];

export const TICKET_CATEGORIES = [
  { value: 'GENERAL', label: 'General' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'PENSION', label: 'Pension' },
  { value: 'WALLET', label: 'Wallet' },
  { value: 'PROFILE', label: 'Profile' },
  { value: 'DOCUMENT', label: 'Documents' },
];

export function TicketStatusBadge({ status, label }) {
  const tone = status === 'OPEN' ? 'warn' : status === 'IN_PROGRESS' ? 'info' : status === 'RESOLVED' ? 'ok' : 'muted';
  const text = label ?? TICKET_STATUSES.find((entry) => entry.value === status)?.label ?? status;
  return <span className={`badge ${tone}`}>{text}</span>;
}

export function TicketChat({
  ticket,
  messages = [],
  loading = false,
  mode = 'investor', // 'investor' | 'admin'
  onReply,
  onClose,
  onStatus,
  onReload,
  emptyHint = 'No messages yet.',
}) {
  const [message, setMessage] = useState('');
  const [nextStatus, setNextStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  if (!ticket) return <div className="empty">Select an inquiry to read the conversation.</div>;
  const closed = ticket.status === 'CLOSED';

  const send = async (event) => {
    event.preventDefault();
    const body = message.trim();
    if (!body) {
      setError('Write a message first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onReply(body, nextStatus ? { status: nextStatus } : undefined);
      setMessage('');
      setNextStatus('');
      await onReload?.();
    } catch (err) {
      setError(err.message ?? 'Could not send the message');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ticket-pane">
      <div className="ticket-head">
        <div style={{ minWidth: 0 }}>
          <div className="inline">
            <strong>{ticket.subject}</strong>
            <TicketStatusBadge status={ticket.status} label={ticket.status_label} />
            <span className="badge brand">{ticket.category_label ?? ticket.category}</span>
            <span className="small muted mono">{ticket.ticket_no}</span>
          </div>
          <div className="small muted">
            Opened {formatDateTime(ticket.created_at)}
            {ticket.investor_name ? ` · ${ticket.investor_name}` : ''}
            {ticket.investor_mobile_masked ? ` · ${ticket.investor_mobile_masked}` : ''}
            {ticket.last_message_by ? ` · last reply by ${ticket.last_message_by === 'ADMIN' ? 'office' : 'member'}` : ''}
          </div>
        </div>
        <div className="spacer" />
        {mode === 'admin' && onStatus && !closed ? (
          <div className="inline">
            <Button className="sm" onClick={() => onStatus('RESOLVED')}>Mark resolved</Button>
            <Button className="sm" onClick={() => onStatus('CLOSED')}>Close</Button>
          </div>
        ) : null}
        {mode === 'investor' && onClose && !closed ? (
          <Button className="sm" onClick={onClose}>Close inquiry</Button>
        ) : null}
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <div className="chat">
          {messages.length === 0 ? <div className="empty">{emptyHint}</div> : null}
          {messages.map((entry) => (
            <div key={entry.id} className={`bubble ${entry.author_type === 'ADMIN' ? 'agent' : 'me'}`}>
              <div className="bubble-meta">
                {entry.author_type === 'ADMIN' ? entry.author || 'Support team' : entry.author || 'Member'} ·{' '}
                {formatDateTime(entry.created_at)}
              </div>
              <div className="bubble-body">{entry.body}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {closed ? (
        <div className="alert info" style={{ marginTop: 12 }}>
          This inquiry is closed. {mode === 'admin' ? 'Reopen it from the status menu to reply.' : 'Open a new inquiry if you still need help.'}
        </div>
      ) : (
        <form onSubmit={send} style={{ marginTop: 12 }}>
          {error ? <div className="alert error">{error}</div> : null}
          <Field label={mode === 'admin' ? 'Reply as the office' : 'Your message'}>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={4000}
              placeholder="Type your message…"
              rows={3}
            />
          </Field>
          <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            {mode === 'admin' ? (
              <label className="inline small">
                Set status
                <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)} style={{ width: 160 }}>
                  <option value="">Keep current</option>
                  {TICKET_STATUSES.filter((entry) => entry.value !== 'CLOSED').map((entry) => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="small muted">The office usually replies within one working day.</span>
            )}
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              {busy ? 'Sending…' : 'Send message'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
