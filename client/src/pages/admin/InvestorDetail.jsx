import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { investorsApi, installmentsApi, paymentsApi, reportsApi } from '../../services/endpoints.js';
import { useApi, useAction } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, ConfirmButton, Field, Input, Modal, Spinner, Table, Tabs } from '../../components/ui.jsx';
import { formatBDT, formatDate, formatDateTime, dueLabel, maskMobile } from '../../utils/format.js';

export function InvestorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isSuperAdmin, atLeast } = useAuth();
  const [tab, setTab] = useState('investments');
  const [nid, setNid] = useState(null);
  const [linkModal, setLinkModal] = useState(null);
  const [payModal, setPayModal] = useState(null);
  const photoInput = useRef(null);
  const scanInput = useRef(null);
  const action = useAction();

  const { data, loading, error, reload } = useApi(() => investorsApi.get(id), [id]);

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const { investor, nominees, investments, installments, payments } = data;

  const upload = async (file, kind) => {
    if (!file) return;
    try {
      await action.run(() => (kind === 'photo' ? investorsApi.uploadPhoto(id, file) : investorsApi.uploadNidScan(id, file)));
      toast.success(kind === 'photo' ? 'Photo uploaded' : 'NID scan uploaded (encrypted)');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const changeStatus = async (status) => {
    try {
      await investorsApi.setStatus(id, { status, reason: `Set to ${status} from investor page` });
      toast.success(`Investor set to ${status}`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const removeInvestor = async () => {
    try {
      await investorsApi.remove(id, { reason: 'Soft deleted from investor page' });
      toast.success('Investor deactivated (soft delete)');
      navigate('/investors');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const revealNid = async () => {
    try {
      const result = await action.run(() => investorsApi.revealNid(id));
      setNid(result.nid);
      toast.info('NID decrypted - this access is recorded in the audit log');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const sendLink = async (installment) => {
    try {
      const result = await installmentsApi.sendLink(installment.id);
      setLinkModal({ installment, url: result.url, sent: result.sent });
      toast.success(result.sent ? 'Payment link sent by SMS' : 'Payment link created (SMS not delivered)');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>{investor.name}</h1>
        <Badge status={investor.status} />
        <span className="badge info mono">{investor.member_code}</span>
        <span className="small muted">
          Portal last login: {investor.last_login_at ? formatDateTime(investor.last_login_at) : 'Never'}
        </span>
        {investor.deleted_at ? <span className="badge danger">Deleted {formatDate(investor.deleted_at)}</span> : null}
        <div className="spacer" />
        {atLeast('ACCOUNTANT') ? (
          <>
            <Button className="sm" onClick={() => navigate(`/investors/${id}/edit`)}>
              Edit
            </Button>
            <Button className="sm" onClick={() => navigate(`/investments/new?investorId=${id}`)}>
              + Investment
            </Button>
          </>
        ) : null}
        <Button className="sm" onClick={() => reportsApi.statementPrint(id)}>
          🖨 Statement
        </Button>
        <Button
          className="sm"
          onClick={async () => {
            try {
              await reportsApi.statementCsv(id);
              toast.success('Statement CSV downloaded');
            } catch (err) {
              toast.error(err.message);
            }
          }}
        >
          ⬇ Statement CSV
        </Button>
      </div>

      <div className="grid cols-3">
        <Card title="Profile">
          <div className="stack small">
            <div>
              <div className="muted">Mobile</div>
              <div className="mono">{isSuperAdmin ? investor.mobile : maskMobile(investor.mobile)}</div>
            </div>
            <div>
              <div className="muted">Address</div>
              <div>{investor.address || '—'}</div>
            </div>
            {investor.email ? (
              <div>
                <div className="muted">Email</div>
                <div>{investor.email}</div>
              </div>
            ) : null}
            {investor.alternate_mobile ? (
              <div>
                <div className="muted">Alternate mobile</div>
                <div className="mono">{isSuperAdmin ? investor.alternate_mobile : maskMobile(investor.alternate_mobile)}</div>
              </div>
            ) : null}
            {investor.date_of_birth || investor.gender ? (
              <div>
                <div className="muted">Date of birth · Gender</div>
                <div>
                  {investor.date_of_birth ? formatDate(investor.date_of_birth) : '—'}
                  {investor.gender ? ` · ${investor.gender}` : ''}
                </div>
              </div>
            ) : null}
            {investor.father_name || investor.mother_name ? (
              <div>
                <div className="muted">Father / husband · Mother</div>
                <div>
                  {investor.father_name || '—'} · {investor.mother_name || '—'}
                </div>
              </div>
            ) : null}
            {investor.religion || investor.education ? (
              <div>
                <div className="muted">Religion · Education</div>
                <div>
                  {investor.religion || '—'}
                  {investor.education ? ` · ${investor.education}` : ''}
                </div>
              </div>
            ) : null}
            {investor.present_address ? (
              <div>
                <div className="muted">Present address</div>
                <div>{investor.present_address}</div>
              </div>
            ) : null}
            {investor.permanent_address ? (
              <div>
                <div className="muted">Permanent address</div>
                <div>{investor.permanent_address}</div>
              </div>
            ) : null}
            <div>
              <div className="muted">NID</div>
              {isSuperAdmin ? (
                <div className="inline">
                  <span className="mono">{nid ?? (investor.nid_last4 ? `••••••••${investor.nid_last4}` : 'not on file')}</span>
                  {investor.has_nid ? (
                    <Button className="sm ghost" onClick={revealNid} disabled={action.busy}>
                      Reveal
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="muted">Restricted to Super Admin</div>
              )}
            </div>
            {investor.notes ? (
              <div>
                <div className="muted">Notes</div>
                <div>{investor.notes}</div>
              </div>
            ) : null}
            <div className="muted">Created {formatDateTime(investor.created_at)}</div>
          </div>

          <div className="inline" style={{ marginTop: 12 }}>
            {investor.status === 'ACTIVE' ? (
              atLeast('ACCOUNTANT') ? (
                <ConfirmButton className="btn sm" onConfirm={() => changeStatus('INACTIVE')} confirmText="Confirm deactivate">
                  Deactivate
                </ConfirmButton>
              ) : null
            ) : atLeast('ACCOUNTANT') ? (
              <Button className="sm" onClick={() => changeStatus('ACTIVE')}>
                Reactivate
              </Button>
            ) : null}
            {atLeast('ACCOUNTANT') && !investor.deleted_at ? (
              <ConfirmButton onConfirm={removeInvestor} confirmText="Really delete?">
                Soft delete
              </ConfirmButton>
            ) : null}
          </div>
        </Card>

        <Card title="Photo & documents">
          <div style={{ marginBottom: 10 }}>
            {investor.has_photo ? (
              <img
                src={investorsApi.photoUrl(id)}
                alt="Investor"
                style={{ width: 130, height: 130, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }}
              />
            ) : (
              <div className="empty">No photo</div>
            )}
          </div>
          {atLeast('ACCOUNTANT') ? (
            <>
              <input
                ref={photoInput}
                type="file"
                accept="image/jpeg,image/png"
                style={{ display: 'none' }}
                onChange={(e) => upload(e.target.files?.[0], 'photo')}
              />
              <Button className="sm" onClick={() => photoInput.current?.click()} disabled={action.busy}>
                Upload photo (max 2 MB)
              </Button>
            </>
          ) : null}
          {isSuperAdmin ? (
            <div style={{ marginTop: 12 }}>
              <div className="muted small">NID scan (encrypted, Super Admin only)</div>
              <input
                ref={scanInput}
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                style={{ display: 'none' }}
                onChange={(e) => upload(e.target.files?.[0], 'scan')}
              />
              <div className="inline" style={{ marginTop: 6 }}>
                <Button className="sm" onClick={() => scanInput.current?.click()} disabled={action.busy}>
                  Upload scan
                </Button>
                {investor.has_nid_scan ? (
                  <Button className="sm ghost" onClick={() => window.open(investorsApi.nidScanUrl(id), '_blank', 'noopener')}>
                    View scan
                  </Button>
                ) : null}
              </div>
              <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                Files are validated by magic bytes, never executed and never served from a public directory.
              </p>
            </div>
          ) : null}
        </Card>

        <Card title={`Nominees (${nominees.length})`}>
          {nominees.length === 0 ? (
            <p className="muted small">No nominees recorded.</p>
          ) : (
            <div className="stack">
              {nominees.map((nominee) => (
                <div key={nominee.id} className="card" style={{ margin: 0, padding: 12 }}>
                  <div className="inline">
                    <strong>{nominee.name}</strong>
                    <span className="badge info">{nominee.share_percent}%</span>
                  </div>
                  <div className="small muted">
                    {nominee.relation} · <span className="mono">{isSuperAdmin ? nominee.mobile : maskMobile(nominee.mobile)}</span>
                    {nominee.nid_last4 ? ` · NID ••••${nominee.nid_last4}` : ''}
                  </div>
                  {isSuperAdmin && nominee.nid_last4 ? (
                    <Button
                      className="sm ghost"
                      style={{ marginTop: 6 }}
                      onClick={async () => {
                        try {
                          const result = await investorsApi.revealNomineeNid(id, nominee.id);
                          toast.info(`Nominee NID: ${result.nid}`);
                        } catch (err) {
                          toast.error(err.message);
                        }
                      }}
                    >
                      Reveal nominee NID
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {isSuperAdmin ? (
            <Button className="sm" style={{ marginTop: 10 }} onClick={() => navigate(`/investors/${id}/edit`)}>
              Manage nominees
            </Button>
          ) : (
            <p className="muted small" style={{ marginTop: 10 }}>
              Only a Super Admin can change nominees.
            </p>
          )}
        </Card>

        <PortalAccessCard investorId={id} canManage={atLeast('ACCOUNTANT')} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'investments', label: `Investments (${investments.length})` },
          { key: 'installments', label: `Installments (${installments.length})` },
          { key: 'payments', label: `Payments (${payments.length})` },
        ]}
      />

      {tab === 'investments' ? (
        <Card>
          <Table
            rows={investments}
            empty="No investments yet."
            columns={[
              { key: 'id', header: 'ID', render: (row) => <Link to={`/investments/${row.id}`}>#{row.id}</Link> },
              { key: 'title', header: 'Title', render: (row) => row.title || '—' },
              { key: 'total_amount', header: 'Total', align: 'right', render: (row) => formatBDT(row.total_amount) },
              { key: 'installment_count', header: 'Installments', align: 'right' },
              { key: 'collected', header: 'Collected', align: 'right', render: (row) => formatBDT(row.collected) },
              { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
              { key: 'next_due_date', header: 'Next due', render: (row) => (row.next_due_date ? formatDate(row.next_due_date) : '—') },
              { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
            ]}
          />
        </Card>
      ) : null}

      {tab === 'installments' ? (
        <Card>
          <Table
            rows={installments}
            empty="No installments yet."
            columns={[
              { key: 'serial', header: 'Installment', render: (row) => `#${row.serial} of ${row.investment_id}` },
              { key: 'due_date', header: 'Due', render: (row) => formatDate(row.due_date) },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              { key: 'amount_paid', header: 'Paid', align: 'right', render: (row) => formatBDT(row.amount_paid) },
              { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <>
                    <Badge status={row.effective_status ?? row.status} />{' '}
                    {row.pay_link_active ? <span className="badge info">link live</span> : null}
                  </>
                ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) =>
                  atLeast('ACCOUNTANT') && ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status ?? row.status) ? (
                    <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                      <Button className="sm" onClick={() => sendLink(row)}>
                        Send link
                      </Button>
                      <Button className="sm" onClick={() => setPayModal(row)}>
                        Record payment
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        </Card>
      ) : null}

      {tab === 'payments' ? (
        <Card>
          <Table
            rows={payments}
            empty="No payments yet."
            columns={[
              { key: 'id', header: 'ID', render: (row) => `#${row.id}` },
              { key: 'installment_serial', header: 'Installment', render: (row) => `#${row.installment_serial}` },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              { key: 'method', header: 'Method' },
              { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
              { key: 'trx_id', header: 'Trx / Ref', mono: true, render: (row) => row.trx_id || row.manual_reference || '—' },
              { key: 'paid_at', header: 'Paid', render: (row) => (row.paid_at ? formatDateTime(row.paid_at) : '—') },
              {
                key: 'receipt',
                header: '',
                align: 'right',
                render: (row) => (row.status === 'SUCCESS' ? <Button className="sm ghost" onClick={() => paymentsApi.openReceipt(row.id)}>Receipt</Button> : null),
              },
            ]}
          />
        </Card>
      ) : null}

      {linkModal ? (
        <Modal title="Payment link" onClose={() => setLinkModal(null)} footer={<Button onClick={() => setLinkModal(null)}>Close</Button>}>
          <p className="muted small">
            Installment #{linkModal.installment.serial} · {formatBDT(linkModal.installment.amount)} · due {formatDate(linkModal.installment.due_date)}
          </p>
          <div className="code-box">{linkModal.url}</div>
          <p className="small">
            {linkModal.sent ? '✓ Sent by SMS to the investor.' : 'SMS was not delivered; you can copy the link above.'}
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

      {payModal ? <ManualPaymentModal installment={payModal} onClose={() => setPayModal(null)} onDone={() => { setPayModal(null); reload(); }} /> : null}
    </>
  );
}

export function ManualPaymentModal({ installment, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState(((Number(installment.amount) - Number(installment.amount_paid || 0)) / 100).toFixed(2));
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await paymentsApi.recordManual({
        installmentId: installment.id,
        amount,
        method,
        reference,
        note: note || undefined,
        notify,
      });
      toast.success(`Payment recorded (${result.receiptNumber})`);
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Record manual payment · installment #${installment.serial}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Outstanding: <strong>{formatBDT(Number(installment.amount) - Number(installment.amount_paid || 0))}</strong> · due {formatDate(installment.due_date)}
        </p>
        <Field label="Amount (BDT)">
          <Input required value={amount} onChange={setAmount} inputMode="decimal" />
        </Field>
        <div className="form-row">
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank transfer</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Reference" hint="Deposit slip / receipt number (required)">
            <Input required value={reference} onChange={setReference} placeholder="e.g. DEP-2026-0091" />
          </Field>
        </div>
        <Field label="Note">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <label className="inline small">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Send SMS confirmation
        </label>
        <div className="inline" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
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

/**
 * Investor self-service portal access: status, temporary password issue/reset,
 * enable/disable and session revoke. The plaintext password is shown exactly
 * once (here) so staff can hand it over; it is never retrievable afterwards.
 */
function PortalAccessCard({ investorId, canManage }) {
  const toast = useToast();
  const { data, loading, error, reload } = useApi(() => investorsApi.portalAccess(investorId), [investorId]);
  const [passwordModal, setPasswordModal] = useState(false);
  const [mode, setMode] = useState('generate');
  const [customPassword, setCustomPassword] = useState('');
  const [sendSms, setSendSms] = useState(false);
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <Card title="🔐 Portal access">
        <Spinner />
      </Card>
    );
  }
  if (error || !data?.portal) {
    return (
      <Card title="🔐 Portal access">
        <Alert tone="error">{error?.message ?? 'Could not load portal status'}</Alert>
      </Card>
    );
  }
  const portal = data.portal;
  const locked = portal.locked_until && new Date(portal.locked_until) > new Date();

  const run = async (fn, successMessage) => {
    setBusy(true);
    try {
      const result = await fn();
      if (successMessage) toast.success(successMessage);
      reload();
      return result;
    } catch (err) {
      toast.error(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (event) => {
    event.preventDefault();
    const result = await run(() =>
      investorsApi.setPortalPassword(investorId, {
        password: mode === 'custom' ? customPassword : undefined,
        sendSms,
      }),
    );
    if (result) {
      setIssued(result);
      toast.success('Portal password set - share it with the investor now (shown once)');
    }
  };

  return (
    <Card title="🔐 Portal access (investor login)">
      <div className="stack small">
        <div className="inline">
          {portal.portal_enabled ? (
            <span className="badge ok">Enabled</span>
          ) : portal.has_password ? (
            <span className="badge muted">Disabled</span>
          ) : (
            <span className="badge warn">Not set up</span>
          )}
          {portal.must_change_password ? <span className="badge warn">Temporary password</span> : null}
          {locked ? <span className="badge danger">Locked until {formatDateTime(portal.locked_until)}</span> : null}
        </div>
        <div>
          <div className="muted">Login id (either works)</div>
          <div>
            Mobile <span className="mono">{portal.mobile}</span> · Member code <span className="mono">{portal.member_code}</span>
          </div>
        </div>
        <div>
          <div className="muted">Login page</div>
          <div className="inline">
            <span className="mono small">{portal.login_url}</span>
            <Button
              className="sm ghost"
              onClick={() => {
                navigator.clipboard?.writeText(portal.login_url);
                toast.success('Login URL copied');
              }}
            >
              Copy
            </Button>
          </div>
        </div>
        <div>
          <div className="muted">Last login</div>
          <div>{portal.last_login_at ? formatDateTime(portal.last_login_at) : 'Never'}</div>
        </div>
        <div>
          <div className="muted">Active sessions</div>
          <div>
            {portal.active_sessions}
            {portal.failed_login_count ? ` · ${portal.failed_login_count} recent failed attempt(s)` : ''}
          </div>
        </div>
      </div>

      {canManage ? (
        <div className="inline" style={{ marginTop: 12 }}>
          <Button
            className="sm primary"
            disabled={busy}
            onClick={() => {
              setIssued(null);
              setCustomPassword('');
              setPasswordModal(true);
            }}
          >
            {portal.has_password ? 'Reset password' : 'Set password & enable'}
          </Button>
          {portal.has_password ? (
            portal.portal_enabled ? (
              <ConfirmButton
                className="btn sm"
                confirmText="Confirm disable"
                onConfirm={() => run(() => investorsApi.setPortalEnabled(investorId, false), 'Portal access disabled')}
              >
                Disable
              </ConfirmButton>
            ) : (
              <Button className="sm" disabled={busy} onClick={() => run(() => investorsApi.setPortalEnabled(investorId, true), 'Portal access enabled')}>
                Enable
              </Button>
            )
          ) : null}
          {portal.active_sessions > 0 ? (
            <Button
              className="sm ghost"
              disabled={busy}
              onClick={() => run(() => investorsApi.revokePortalSessions(investorId), 'Investor signed out everywhere')}
            >
              Sign out everywhere
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="muted small" style={{ marginTop: 10 }}>Viewer role cannot manage portal access.</p>
      )}

      {passwordModal ? (
        <Modal title={portal.has_password ? 'Reset portal password' : 'Set portal password'} onClose={() => setPasswordModal(false)}>
          {issued ? (
            <>
              <Alert tone="ok">Temporary password set. It is shown <strong>only now</strong> - it cannot be viewed again.</Alert>
              <div className="muted small">Temporary password</div>
              <div className="code-box">{issued.tempPassword}</div>
              <p className="small">
                Login page: <span className="mono">{issued.portal.login_url}</span>
                <br />
                Login id: mobile <span className="mono">{issued.portal.mobile}</span> or member code{' '}
                <span className="mono">{issued.portal.member_code}</span>
                <br />
                {issued.sms ? (issued.sms.sent ? '✓ Credentials also sent by SMS.' : '⚠ SMS was not delivered - please share the password another way.') : null}
                <br />
                The investor must change this password at first sign-in.
              </p>
              <div className="inline" style={{ justifyContent: 'flex-end' }}>
                <Button
                  className="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(issued.tempPassword);
                    toast.success('Password copied');
                  }}
                >
                  Copy password
                </Button>
                <Button className="sm primary" onClick={() => setPasswordModal(false)}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <form onSubmit={submitPassword}>
              <label className="inline small" style={{ display: 'flex', marginBottom: 8 }}>
                <input type="radio" name="pw-mode" checked={mode === 'generate'} onChange={() => setMode('generate')} />
                Auto-generate a temporary password (recommended)
              </label>
              <label className="inline small" style={{ display: 'flex', marginBottom: 8 }}>
                <input type="radio" name="pw-mode" checked={mode === 'custom'} onChange={() => setMode('custom')} />
                I will type a temporary password
              </label>
              {mode === 'custom' ? (
                <Field label="Temporary password" hint="At least 8 characters with a letter and a digit; not the mobile number or member code.">
                  <Input required value={customPassword} onChange={setCustomPassword} autoComplete="new-password" />
                </Field>
              ) : null}
              <label className="inline small">
                <input type="checkbox" checked={sendSms} onChange={(e) => setSendSms(e.target.checked)} /> Send credentials
                by SMS to {portal.mobile}
              </label>
              <p className="muted small" style={{ marginTop: 10 }}>
                Setting a password enables portal access, signs the investor out everywhere, clears any lock, and
                forces a password change at first sign-in.
              </p>
              <div className="inline" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
                <Button type="button" className="sm" onClick={() => setPasswordModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={busy}>
                  {busy ? 'Saving…' : portal.has_password ? 'Reset password' : 'Set password & enable'}
                </Button>
              </div>
            </form>
          )}
        </Modal>
      ) : null}
    </Card>
  );
}
