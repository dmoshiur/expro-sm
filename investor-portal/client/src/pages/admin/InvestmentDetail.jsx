import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { investmentsApi, installmentsApi, paymentsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, ConfirmButton, Field, Input, Kpi, Modal, Spinner, Table, Tabs } from '../../components/ui.jsx';
import { formatBDT, formatDate, formatDateTime, poishaToTakaInput, takaToPoisha, dueLabel } from '../../utils/format.js';

export function InvestmentDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { atLeast } = useAuth();
  const [tab, setTab] = useState('installments');
  const [edits, setEdits] = useState({});
  const [linkModal, setLinkModal] = useState(null);
  const [stateModal, setStateModal] = useState(null);
  const [totalModal, setTotalModal] = useState(false);

  const { data, loading, error, reload } = useApi(() => investmentsApi.get(id), [id]);

  useEffect(() => {
    setEdits({});
  }, [data]);

  const editedSum = useMemo(() => {
    if (!data) return 0;
    return data.installments.reduce((sum, row) => {
      const edit = edits[row.id];
      const amount = edit?.amount !== undefined ? takaToPoisha(edit.amount) : Number(row.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  }, [data, edits]);

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;

  const { investment, installments, payments } = data;
  const sumMatches = editedSum === Number(investment.total_amount);

  const saveEdit = async (row) => {
    const edit = edits[row.id];
    if (!edit) return;
    try {
      await installmentsApi.update(row.id, {
        amount: edit.amount !== undefined ? takaToPoisha(edit.amount) : undefined,
        due_date: edit.due_date !== undefined ? edit.due_date : undefined,
      });
      toast.success(`Installment #${row.serial} updated`);
      setEdits((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const issueLink = async (row, regenerate) => {
    try {
      const result = await installmentsApi.issueLink(row.id, { regenerate: String(regenerate) });
      setLinkModal({ row, url: result.url, expires: result.tokenExpiresAt, version: result.tokenVersion });
      toast.success(regenerate ? 'New link generated (previous link invalidated)' : 'Payment link ready');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const sendLink = async (row) => {
    try {
      const result = await installmentsApi.sendLink(row.id);
      setLinkModal({ row, url: result.url, sent: result.sent });
      toast.success(result.sent ? `Link sent to ${row.investor_mobile}` : 'SMS not delivered');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const bulkSend = async () => {
    const ids = installments
      .filter((row) => ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status ?? row.status) && !row.pay_link_active)
      .map((row) => row.id)
      .slice(0, 50);
    if (!ids.length) {
      toast.info('Every open installment already has a live link. Use "send" per row to re-deliver.');
      return;
    }
    try {
      const result = await installmentsApi.bulkSendLinks(ids);
      toast.success(`Sent ${result.sent} of ${result.requested} payment links`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const changeTotal = async (form) => {
    try {
      await investmentsApi.updateTotal(id, form);
      toast.success('Total updated and redistributed across open installments');
      setTotalModal(false);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>
          Investment #{investment.id} <span className="muted">·</span> <Link to={`/investors/${investment.investor_id}`}>{investment.investor_name}</Link>
        </h1>
        <Badge status={investment.status} />
        <div className="spacer" />
        {atLeast('ACCOUNTANT') ? (
          <>
            <Button className="sm" onClick={bulkSend}>
              ✉ Send links
            </Button>
            <Button className="sm" onClick={() => setTotalModal(true)}>
              Adjust total
            </Button>
            <ConfirmButton className="btn sm" onConfirm={async () => {
              try {
                await investmentsApi.setStatus(id, { status: 'CANCELLED', reason: 'Cancelled from investment page' });
                toast.success('Investment cancelled');
                reload();
              } catch (err) {
                toast.error(err.message);
              }
            }} confirmText="Confirm cancel investment">
              Cancel investment
            </ConfirmButton>
          </>
        ) : null}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Kpi label="Total" value={formatBDT(investment.total_amount)} hint={`${investment.installment_count} installments`} />
        <Kpi label="Collected" value={formatBDT(investment.amount_collected)} tone="ok" />
        <Kpi label="Outstanding" value={formatBDT(investment.amount_outstanding)} tone={Number(investment.amount_outstanding) ? 'warn' : ''} />
        <Kpi
          label="Next due"
          value={investment.next_due_date ? formatDate(investment.next_due_date) : '—'}
          hint={investment.next_due_date ? dueLabel(investment.next_due_date) : 'all settled'}
        />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'installments', label: `Installments (${installments.length})` },
          { key: 'payments', label: `Payments (${payments.length})` },
        ]}
      />

      {tab === 'installments' ? (
        <Card
          title="Installment schedule"
          actions={
            !sumMatches ? (
              <span className="badge danger">
                edited sum {formatBDT(editedSum)} ≠ total {formatBDT(investment.total_amount)}
              </span>
            ) : (
              <span className="badge ok">sum matches total</span>
            )
          }
        >
          <Table
            rows={installments}
            empty="No installments."
            columns={[
              { key: 'serial', header: '#', render: (row) => `#${row.serial}` },
              {
                key: 'amount',
                header: 'Amount (BDT)',
                align: 'right',
                render: (row) => {
                  const editable = atLeast('ACCOUNTANT') && !['PAID', 'CANCELLED'].includes(row.status);
                  if (!editable) return formatBDT(row.amount);
                  return (
                    <Input
                      style={{ width: 120, textAlign: 'right' }}
                      value={edits[row.id]?.amount ?? poishaToTakaInput(row.amount)}
                      onChange={(value) => setEdits((current) => ({ ...current, [row.id]: { ...current[row.id], amount: value } }))}
                    />
                  );
                },
              },
              {
                key: 'due_date',
                header: 'Due date',
                render: (row) => {
                  const editable = atLeast('ACCOUNTANT') && !['PAID', 'CANCELLED'].includes(row.status);
                  if (!editable) return formatDate(row.due_date);
                  return (
                    <Input
                      type="date"
                      style={{ width: 155 }}
                      value={edits[row.id]?.due_date ?? String(row.due_date).slice(0, 10)}
                      onChange={(value) => setEdits((current) => ({ ...current, [row.id]: { ...current[row.id], due_date: value } }))}
                    />
                  );
                },
              },
              { key: 'amount_paid', header: 'Paid', align: 'right', render: (row) => formatBDT(row.amount_paid) },
              { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <div className="pill-row">
                    <Badge status={row.effective_status ?? row.status} />
                    {row.pay_link_active ? <span className="badge info">link live</span> : null}
                    {row.status_reason ? <span className="badge muted" title={row.status_reason}>{row.status_reason.slice(0, 18)}…</span> : null}
                  </div>
                ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                    {edits[row.id] ? (
                      <Button className="sm primary" onClick={() => saveEdit(row)}>
                        Save
                      </Button>
                    ) : null}
                    {atLeast('ACCOUNTANT') && !['PAID', 'CANCELLED'].includes(row.status) ? (
                      <>
                        <Button className="sm" onClick={() => issueLink(row, false)}>
                          Link
                        </Button>
                        <Button className="sm ghost" onClick={() => issueLink(row, true)} title="Invalidate the old link">
                          Regenerate
                        </Button>
                        <Button className="sm" onClick={() => sendLink(row)}>
                          ✉ SMS
                        </Button>
                        <Button className="sm ghost" onClick={() => setStateModal(row)}>
                          ⋯
                        </Button>
                      </>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
          <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
            Amounts are stored in poisha; the server re-validates that the schedule still sums to the investment total on every save.
          </p>
        </Card>
      ) : null}

      {tab === 'payments' ? (
        <Card title="Payments">
          <Table
            rows={payments}
            empty="No payments yet."
            columns={[
              { key: 'id', header: 'ID', render: (row) => `#${row.id}` },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              { key: 'method', header: 'Method' },
              { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
              { key: 'trx_id', header: 'Trx / Ref', mono: true, render: (row) => row.trx_id || row.manual_reference || '—' },
              { key: 'gateway_status', header: 'Gateway', render: (row) => row.gateway_status || '—' },
              { key: 'created_at', header: 'Created', render: (row) => formatDateTime(row.created_at) },
              { key: 'paid_at', header: 'Paid', render: (row) => (row.paid_at ? formatDateTime(row.paid_at) : '—') },
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
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      {linkModal ? (
        <Modal
          title={`Payment link · installment #${linkModal.row.serial}`}
          onClose={() => setLinkModal(null)}
          footer={<Button onClick={() => setLinkModal(null)}>Close</Button>}
        >
          <p className="muted small">
            {formatBDT(linkModal.row.amount)} · due {formatDate(linkModal.row.due_date)}
            {linkModal.expires ? ` · expires ${formatDateTime(linkModal.expires)}` : ''}
          </p>
          <div className="code-box">{linkModal.url}</div>
          <p className="small">
            Only the SHA-256 hash of this token is stored. Regenerating a link invalidates the previous one immediately.
          </p>
          <Button
            className="sm"
            onClick={() => {
              navigator.clipboard?.writeText(linkModal.url);
              toast.success('Link copied');
            }}
          >
            Copy link
          </Button>
        </Modal>
      ) : null}

      {stateModal ? (
        <StateModal
          row={stateModal}
          onClose={() => setStateModal(null)}
          onDone={() => {
            setStateModal(null);
            reload();
          }}
        />
      ) : null}

      {totalModal ? <TotalModal investment={investment} onClose={() => setTotalModal(false)} onSubmit={changeTotal} /> : null}
    </>
  );
}

function StateModal({ row, onClose, onDone }) {
  const toast = useToast();
  const [state, setState] = useState('WAIVED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await installmentsApi.setState(row.id, { status: state, reason });
      toast.success(`Installment #${row.serial} marked ${state}`);
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Change installment #${row.serial}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Action">
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="WAIVED">Waive (no longer collectable)</option>
            <option value="CANCELLED">Cancel</option>
            <option value="PENDING">Reinstate (back to open)</option>
          </select>
        </Field>
        <Field label="Reason" hint="Required for waive / cancel. Stored in the audit log.">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required={state !== 'PENDING'} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            Apply
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TotalModal({ investment, onClose, onSubmit }) {
  const [amount, setAmount] = useState(poishaToTakaInput(investment.total_amount));
  const [reason, setReason] = useState('');
  const [strategy, setStrategy] = useState('REDISTRIBUTE');
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Adjust investment total" onClose={onClose}>
      <p className="muted small">
        The difference is spread across the installments that are still open (paid/waived/cancelled rows are never touched) so the
        schedule keeps adding up to the total exactly.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          await onSubmit({ totalAmount: amount, reason, strategy });
          setBusy(false);
        }}
      >
        <Field label="New total (BDT)">
          <Input value={amount} onChange={setAmount} required inputMode="decimal" />
        </Field>
        <Field label="Strategy">
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="REDISTRIBUTE">Even split across open installments</option>
            <option value="SCALE">Proportional to current amounts</option>
          </select>
        </Field>
        <Field label="Reason">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
