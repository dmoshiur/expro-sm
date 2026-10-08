import { useState } from 'react';
import { Link } from 'react-router-dom';
import { paymentsApi } from '../../services/endpoints.js';
import { useApi, useDebounce } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, ConfirmButton, Field, Input, Modal, Pagination, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDateTime, formatDate, takaToPoisha } from '../../utils/format.js';

export function PaymentsList() {
  const toast = useToast();
  const { atLeast } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [paidFrom, setPaidFrom] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [page, setPage] = useState(1);
  const [manualModal, setManualModal] = useState(false);
  const debounced = useDebounce(search);

  const params = { search: debounced, status, method, paidFrom, paidTo, page, limit: 25 };
  const { data, loading, error, reload } = useApi(() => paymentsApi.list(params), [debounced, status, method, paidFrom, paidTo, page]);
  const provider = useApi(() => paymentsApi.provider(), []);

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Payments</h1>
        {provider.data ? (
          <span className="badge info">
            {provider.data.provider.toUpperCase()} · {provider.data.sandbox ? 'sandbox' : 'live'}
          </span>
        ) : null}
        <div className="spacer" />
        <Button className="sm" onClick={() => paymentsApi.openHtml('/reports/payments.html', params)}>
          🖨 Printable ledger
        </Button>
        <Button
          className="sm"
          onClick={async () => {
            try {
              await paymentsApi.exportCsv(params);
              toast.success('CSV downloaded');
            } catch (err) {
              toast.error(err.message);
            }
          }}
        >
          ⬇ Export CSV
        </Button>
        {atLeast('ACCOUNTANT') ? (
          <Button variant="primary" size="sm" onClick={() => setManualModal(true)}>
            + Record manual payment
          </Button>
        ) : null}
      </div>

      <Card>
        <div className="filters">
          <div className="field" style={{ minWidth: 240 }}>
            <label htmlFor="search">Search</label>
            <Input id="search" value={search} onChange={setSearch} placeholder="Investor, trx id, reference, payment #" />
          </div>
          <div className="field">
            <label htmlFor="status">Status</label>
            <Select
              id="status"
              value={status}
              onChange={(value) => { setStatus(value); setPage(1); }}
              options={[
                { value: '', label: 'Any' },
                { value: 'SUCCESS', label: 'Success' },
                { value: 'INITIATED', label: 'Initiated' },
                { value: 'PENDING', label: 'Pending' },
                { value: 'FAILED', label: 'Failed' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
            />
          </div>
          <div className="field">
            <label htmlFor="method">Method</label>
            <Select
              id="method"
              value={method}
              onChange={(value) => { setMethod(value); setPage(1); }}
              options={[
                { value: '', label: 'Any' },
                { value: 'BKASH', label: 'bKash' },
                { value: 'CASH', label: 'Cash' },
                { value: 'BANK', label: 'Bank' },
                { value: 'OTHER', label: 'Other' },
              ]}
            />
          </div>
          <div className="field">
            <label htmlFor="from">Paid from</label>
            <Input id="from" type="date" value={paidFrom} onChange={setPaidFrom} />
          </div>
          <div className="field">
            <label htmlFor="to">Paid to</label>
            <Input id="to" type="date" value={paidTo} onChange={setPaidTo} />
          </div>
          <Button className="sm" onClick={reload}>⟳</Button>
        </div>

        <Alert tone="error">{error?.message}</Alert>
        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <Table
              rows={data?.items ?? []}
              empty="No payments match these filters."
              columns={[
                { key: 'id', header: '#', render: (row) => `#${row.id}` },
                { key: 'investor', header: 'Investor', render: (row) => <Link to={`/investors/${row.investor_id}`}>{row.investor_name}</Link> },
                { key: 'investment', header: 'Investment', render: (row) => <Link to={`/investments/${row.investment_id}`}>#{row.investment_id}</Link> },
                { key: 'installment_serial', header: 'Inst.', render: (row) => `#${row.installment_serial}` },
                { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                { key: 'method', header: 'Method', render: (row) => <span className="badge muted">{row.method}</span> },
                { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
                { key: 'trx', header: 'Trx / Ref', mono: true, render: (row) => row.trx_id || row.manual_reference || '—' },
                { key: 'created_at', header: 'Created', render: (row) => formatDateTime(row.created_at) },
                { key: 'paid_at', header: 'Paid', render: (row) => (row.paid_at ? formatDate(row.paid_at) : '—') },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                      {row.status === 'SUCCESS' ? (
                        <Button className="sm ghost" onClick={() => paymentsApi.openReceipt(row.id)}>
                          Receipt
                        </Button>
                      ) : null}
                      {atLeast('ACCOUNTANT') && ['INITIATED', 'PENDING'].includes(row.status) ? (
                        <>
                          <Button
                            className="sm ghost"
                            onClick={async () => {
                              try {
                                const result = await paymentsApi.refresh(row.id);
                                toast.success(`Gateway says: ${result.state}`);
                                reload();
                              } catch (err) {
                                toast.error(err.message);
                              }
                            }}
                          >
                            Re-check
                          </Button>
                          <ConfirmButton
                            className="btn ghost sm"
                            confirmText="Confirm cancel"
                            onConfirm={async () => {
                              try {
                                await paymentsApi.cancel(row.id, { reason: 'Cancelled by admin' });
                                toast.success('Payment cancelled');
                                reload();
                              } catch (err) {
                                toast.error(err.message);
                              }
                            }}
                          >
                            Cancel
                          </ConfirmButton>
                        </>
                      ) : null}
                    </div>
                  ),
                },
              ]}
              footer={
                data
                  ? [
                      <td key="label">Successful total</td>,
                      <td key="amount" className="num" colSpan={8}>
                        {formatBDT(data.successAmount)}
                      </td>,
                      <td key="empty" />,
                    ]
                  : null
              }
            />
            <Pagination meta={data?.meta} onPage={setPage} />
          </>
        )}
      </Card>

      {manualModal ? <ManualPaymentLookup onClose={() => setManualModal(false)} onDone={() => { setManualModal(false); reload(); }} /> : null}
    </>
  );
}

/**
 * Manual payments need an installment id (an accountant normally starts from
 * the installment row, which opens the same form prefilled). This dialog looks
 * the installment up by number so the payments page is self-sufficient.
 */
function ManualPaymentLookup({ onClose, onDone }) {
  const toast = useToast();
  const [installmentId, setInstallmentId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await paymentsApi.recordManual({
        installmentId: Number(installmentId),
        amount: takaToPoisha(amount),
        method,
        reference,
        note: note || undefined,
      });
      toast.success(`Payment recorded · ${result.receiptNumber}`);
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Record manual payment" onClose={onClose}>
      <Alert tone="info">
        Tip: you can also open the installment from an investment or the investor page and use “Record payment” there.
      </Alert>
      <form onSubmit={submit}>
        <Field label="Installment ID">
          <Input value={installmentId} onChange={setInstallmentId} required inputMode="numeric" placeholder="e.g. 42" />
        </Field>
        <Field label="Amount (BDT)">
          <Input value={amount} onChange={setAmount} required inputMode="decimal" />
        </Field>
        <div className="form-row">
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank transfer</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Reference" hint="Required (slip / deposit number)">
            <Input value={reference} onChange={setReference} required placeholder="DEP-2026-0091" />
          </Field>
        </div>
        <Field label="Note">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Record payment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
