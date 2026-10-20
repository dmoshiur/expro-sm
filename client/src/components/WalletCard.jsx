/**
 * Wallet widgets shared by the investor portal and the admin profile:
 *   <WalletCard />            deep-sky balance card
 *   <WalletRequestModal />    deposit / withdrawal request (investor)
 *   <WalletEntryModal />      manual ledger entry (staff)
 *   <WalletRequests />        pending requests with approve / reject
 *   <WalletLedger />          transaction timeline
 */
import { useState } from 'react';
import { Badge, Button, Field, Input, Modal, Select, Table } from './ui.jsx';
import { formatBDT, formatDateTime } from '../utils/format.js';

const METHODS = [
  { value: 'BKASH', label: 'bKash' },
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK', label: 'Bank transfer' },
  { value: 'OTHER', label: 'Other' },
];

const ENTRY_TYPES = [
  { value: 'DEPOSIT', label: 'Deposit (credit)' },
  { value: 'EARNING', label: 'Earning / profit (credit)' },
  { value: 'WITHDRAWAL', label: 'Withdrawal (debit)' },
  { value: 'FEE', label: 'Fee (debit)' },
  { value: 'ADJUSTMENT', label: 'Manual adjustment (choose direction)' },
];

export function WalletCard({ summary, title = 'My wallet', subtitle = 'Live ledger balance', actions = null }) {
  const data = summary ?? {};
  return (
    <section className="wallet-card" aria-label={title}>
      <div className="wallet-top">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wallet-label">{title}</div>
          <div className="wallet-balance">{formatBDT(data.balance ?? 0)}</div>
          <div className="wallet-sub">
            {subtitle}
            {data.pending_requests ? ` · ${data.pending_requests} request${data.pending_requests === 1 ? '' : 's'} pending` : ''}
          </div>
        </div>
        <span className="badge brand" style={{ background: 'rgba(255,255,255,.14)', color: '#fff' }}>
          BDT
        </span>
      </div>
      <div className="wallet-metrics">
        <div className="metric">
          <div className="label">Total earned</div>
          <div className="value">{formatBDT(data.total_earned ?? 0)}</div>
        </div>
        <div className="metric">
          <div className="label">Total deposited</div>
          <div className="value">{formatBDT(data.total_deposited ?? 0)}</div>
        </div>
        <div className="metric">
          <div className="label">Total withdrawn</div>
          <div className="value">{formatBDT(data.total_withdrawn ?? 0)}</div>
        </div>
      </div>
      {data.pending_withdrawals || data.pending_deposits ? (
        <div className="wallet-sub" style={{ marginTop: 10 }}>
          Available {formatBDT(data.available_balance ?? data.balance ?? 0)} · pending deposits{' '}
          {formatBDT(data.pending_deposits ?? 0)} · pending withdrawals {formatBDT(data.pending_withdrawals ?? 0)}
        </div>
      ) : null}
      {actions ? <div className="wallet-actions">{actions}</div> : null}
    </section>
  );
}

/** Investor: request a deposit or a withdrawal. */
export function WalletRequestModal({ type, onClose, onSubmit }) {
  const isWithdrawal = type === 'WITHDRAWAL';
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(isWithdrawal ? 'BKASH' : 'BKASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  const submit = async (event) => {
    event.preventDefault();
    const value = Number(String(amount).replace(/[,\s৳]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setErrors({ amount: 'Enter an amount greater than zero' });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await onSubmit({
        type,
        amount: value.toFixed(2),
        method,
        reference: reference || undefined,
        note: note || undefined,
      });
    } catch (err) {
      setErrors(err.details ?? {});
      if (!err.details) setErrors({ form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={isWithdrawal ? 'Request a withdrawal' : 'Request a deposit'} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted">
          {isWithdrawal
            ? 'The office reviews withdrawal requests before money leaves your wallet. Pending requests reduce your available balance.'
            : 'Tell the office how you will deposit the money. The balance updates after the payment is confirmed.'}
        </p>
        {errors.form ? <div className="alert error">{errors.form}</div> : null}
        <Field label="Amount (BDT)" error={errors.amount}>
          <Input value={amount} onChange={setAmount} inputMode="decimal" placeholder="e.g. 1,000" autoFocus />
        </Field>
        <div className="form-row">
          <Field label={isWithdrawal ? 'Receive via' : 'Deposit via'} error={errors.method}>
            <Select value={method} onChange={setMethod} options={METHODS} />
          </Field>
          <Field label="Reference (optional)" error={errors.reference} hint="bKash Trx ID, deposit slip…">
            <Input value={reference} onChange={setReference} maxLength={120} />
          </Field>
        </div>
        <Field label="Note (optional)" error={errors.note}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Sending…' : isWithdrawal ? 'Request withdrawal' : 'Request deposit'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Staff: manual ledger entry, written straight to COMPLETED. */
export function WalletEntryModal({ onClose, onSubmit, title = 'Manual ledger entry' }) {
  const [type, setType] = useState('DEPOSIT');
  const [direction, setDirection] = useState('CREDIT');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  const submit = async (event) => {
    event.preventDefault();
    const value = Number(String(amount).replace(/[,\s৳]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setErrors({ amount: 'Enter an amount greater than zero' });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await onSubmit({
        type,
        direction: type === 'ADJUSTMENT' ? direction : undefined,
        amount: value.toFixed(2),
        method: type === 'DEPOSIT' || type === 'WITHDRAWAL' ? method : undefined,
        externalReference: reference || undefined,
        note: note || undefined,
      });
    } catch (err) {
      setErrors(err.details ?? { form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small muted">Ledger entries are audited and take effect immediately.</p>
        {errors.form ? <div className="alert error">{errors.form}</div> : null}
        <div className="form-row">
          <Field label="Type" error={errors.type}>
            <Select value={type} onChange={setType} options={ENTRY_TYPES} />
          </Field>
          {type === 'ADJUSTMENT' ? (
            <Field label="Direction" error={errors.direction}>
              <Select
                value={direction}
                onChange={setDirection}
                options={[{ value: 'CREDIT', label: 'Credit (add)' }, { value: 'DEBIT', label: 'Debit (deduct)' }]}
              />
            </Field>
          ) : null}
        </div>
        <div className="form-row">
          <Field label="Amount (BDT)" error={errors.amount}>
            <Input value={amount} onChange={setAmount} inputMode="decimal" placeholder="e.g. 5,000" autoFocus />
          </Field>
          <Field label="Method" error={errors.method}>
            <Select value={method} onChange={setMethod} options={METHODS} />
          </Field>
        </div>
        <Field label="Reference" error={errors.externalReference} hint="Deposit slip / bKash Trx ID">
          <Input value={reference} onChange={setReference} maxLength={120} />
        </Field>
        <Field label="Note" error={errors.note}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Post entry'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DecisionModal({ transaction, decision, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const approve = decision === 'APPROVE';

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ decision, note: note.trim() || undefined });
    } catch (err) {
      setError(err.message ?? 'Could not save the decision');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={approve ? 'Approve wallet request' : 'Reject wallet request'} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="small">
          {transaction.type_label ?? transaction.type} · <strong>{formatBDT(transaction.amount)}</strong> ·{' '}
          {transaction.reference}
        </p>
        {error ? <div className="alert error">{error}</div> : null}
        <Field label={approve ? 'Note (optional)' : 'Reason (recommended)'}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={approve ? 'primary' : 'danger'} size="sm" disabled={busy}>
            {busy ? 'Saving…' : approve ? 'Approve request' : 'Reject request'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Pending requests table with approve / reject actions (staff). */
export function WalletRequests({ transactions = [], onDecide, empty = 'No pending wallet requests.' }) {
  const [choice, setChoice] = useState(null);
  const pending = transactions.filter((tx) => tx.status === 'PENDING');
  return (
    <>
      <Table
        rows={pending}
        empty={empty}
        columns={[
          { key: 'requested_at', header: 'Requested', render: (row) => formatDateTime(row.requested_at ?? row.created_at) },
          { key: 'type_label', header: 'Type', render: (row) => row.type_label ?? row.type },
          { key: 'reference', header: 'Reference', mono: true, render: (row) => row.reference },
          { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
          { key: 'method', header: 'Method', render: (row) => row.method ?? '—' },
          { key: 'note', header: 'Note', render: (row) => row.note ?? '—' },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (row) => (
              <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                <Button className="sm primary" onClick={() => setChoice({ transaction: row, decision: 'APPROVE' })}>Approve</Button>
                <Button className="sm danger" onClick={() => setChoice({ transaction: row, decision: 'REJECT' })}>Reject</Button>
              </div>
            ),
          },
        ]}
      />
      {choice ? (
        <DecisionModal
          transaction={choice.transaction}
          decision={choice.decision}
          onClose={() => setChoice(null)}
          onSubmit={async (payload) => {
            await onDecide(choice.transaction.id, payload);
            setChoice(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Ledger timeline with credit/debit colouring and pending/rejected states. */
export function WalletLedger({ transactions = [], empty = 'No wallet transactions yet.' }) {
  if (!transactions.length) return <div className="empty">{empty}</div>;
  return (
    <div className="timeline">
      {transactions.map((tx) => {
        const credit = tx.direction === 'CREDIT';
        return (
          <div key={tx.id} className={`entry ${credit ? '' : 'debit'} ${tx.status === 'PENDING' ? 'pending' : ''}`}>
            <span className="dot" aria-hidden="true" />
            <div className="body">
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <strong>{tx.type_label ?? tx.type}</strong>
                <span className={`amount ${credit ? 'credit' : 'debit'}`}>
                  {credit ? '+' : '−'}
                  {formatBDT(tx.amount)}
                </span>
              </div>
              <div className="small muted">
                {formatDateTime(tx.reviewed_at ?? tx.requested_at ?? tx.created_at)} · {tx.reference}
                {tx.method ? ` · ${tx.method}` : ''}
                {tx.external_reference ? ` · ref ${tx.external_reference}` : ''}
              </div>
              {tx.note ? <div className="small">{tx.note}</div> : null}
              {tx.review_note ? <div className="small muted">Office: {tx.review_note}</div> : null}
            </div>
            <div>
              <Badge
                label={tx.status_label ?? tx.status}
                status={tx.status === 'COMPLETED' ? 'SUCCESS' : tx.status === 'REJECTED' ? 'FAILED' : tx.status === 'PENDING' ? 'PENDING' : 'CANCELLED'}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
