import { useState } from 'react';
import { smsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Field, Input, Modal, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

export function SmsLog() {
  const toast = useToast();
  const [messageType, setMessageType] = useState('');
  const [providerStatus, setProviderStatus] = useState('');
  const [page, setPage] = useState(1);
  const [testOpen, setTestOpen] = useState(false);

  const provider = useApi(() => smsApi.provider(), []);
  const { data, loading, error } = useApi(() => smsApi.list({ messageType, providerStatus, page, limit: 50 }), [messageType, providerStatus, page]);

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>SMS log</h1>
        {provider.data ? (
          <span className="badge info">
            {provider.data.provider}
            {provider.data.dryRun ? ' · dry run' : ''}
          </span>
        ) : null}
        <div className="spacer" />
        <Button className="sm" onClick={() => setTestOpen(true)}>
          Send test SMS
        </Button>
      </div>

      <Card>
        <div className="filters">
          <div className="field">
            <label htmlFor="type">Type</label>
            <Select
              id="type"
              value={messageType}
              onChange={(value) => { setMessageType(value); setPage(1); }}
              options={[
                { value: '', label: 'All' },
                { value: 'PAYMENT_LINK', label: 'Payment link' },
                { value: 'DUE_REMINDER', label: 'Due reminder' },
                { value: 'OVERDUE_REMINDER', label: 'Overdue reminder' },
                { value: 'PAYMENT_SUCCESS', label: 'Payment confirmation' },
                { value: 'MANUAL', label: 'Manual payment' },
                { value: 'TEST', label: 'Test' },
              ]}
            />
          </div>
          <div className="field">
            <label htmlFor="status">Provider status</label>
            <Select
              id="status"
              value={providerStatus}
              onChange={(value) => { setProviderStatus(value); setPage(1); }}
              options={[
                { value: '', label: 'Any' },
                { value: 'SENT', label: 'Sent' },
                { value: 'FAILED', label: 'Failed' },
              ]}
            />
          </div>
        </div>

        <Alert tone="error">{error?.message}</Alert>
        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              empty="No SMS sent yet."
              columns={[
                { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
                { key: 'investor_name', header: 'Investor', render: (row) => row.investor_name ?? '—' },
                { key: 'mobile_masked', header: 'To', mono: true },
                { key: 'message_type', header: 'Type', render: (row) => <span className="badge muted">{row.message_type}</span> },
                { key: 'provider', header: 'Provider' },
                { key: 'provider_status', header: 'Status', render: (row) => <Badge status={row.provider_status === 'SENT' ? 'SUCCESS' : 'FAILED'} label={row.provider_status} /> },
                { key: 'body_preview', header: 'Message preview', render: (row) => <span className="small muted">{row.body_preview}</span> },
                { key: 'error', header: 'Error', render: (row) => (row.error ? <span className="small" style={{ color: 'var(--danger)' }}>{row.error}</span> : '—') },
              ]}
            />
            <Pagination meta={data?.meta} onPage={setPage} />
          </>
        )}
      </Card>

      {testOpen ? <TestSmsModal onClose={() => setTestOpen(false)} /> : null}
    </>
  );
}

function TestSmsModal({ onClose }) {
  const toast = useToast();
  const [mobile, setMobile] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Send test SMS" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await smsApi.test({ mobile, message: message || undefined });
            toast.success('Test SMS handed to the provider');
            onClose();
          } catch (err) {
            toast.error(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Mobile number">
          <Input required value={mobile} onChange={setMobile} placeholder="01712345678" />
        </Field>
        <Field label="Message" hint="Leave empty to send the built-in test message.">
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
