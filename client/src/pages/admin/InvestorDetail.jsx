import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { investorsApi, installmentsApi, paymentsApi, reportsApi } from '../../services/endpoints.js';
import { useApi, useAction, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmButton,
  Field,
  Input,
  Modal,
  ProgressBar,
  Spinner,
  TabBar,
  Table,
} from '../../components/ui.jsx';
import { DocumentSlot } from '../../components/DocumentSlot.jsx';
import { InlineEditField } from '../../components/InlineEdit.jsx';
import { WalletCard, WalletEntryModal, WalletLedger, WalletRequests } from '../../components/WalletCard.jsx';
import { AlertBanners } from '../../components/AlertBanners.jsx';
import { PROFILE_TABS, normaliseTab } from '../profileTabs.js';
import { formatBDT, formatDate, formatDateTime, dueLabel, maskMobile, relativeDays } from '../../utils/format.js';

const GENDER_OPTIONS = [
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'OTHER', label: 'Other' },
];

export function InvestorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isSuperAdmin, atLeast } = useAuth();
  const canWrite = atLeast('ACCOUNTANT');
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = normaliseTab(searchParams.get('tab'));
  const setTab = (key) => setSearchParams({ tab: key });
  const [nid, setNid] = useState(null);
  const [linkModal, setLinkModal] = useState(null);
  const [payModal, setPayModal] = useState(null);
  const [walletEntryOpen, setWalletEntryOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [membershipDecision, setMembershipDecision] = useState(null);
  const action = useAction();

  const { data, loading, error, reload } = useApi(() => investorsApi.get(id), [id]);
  useRefreshOnFocus(reload, { intervalMs: 60000 });

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;

  const { investor, nominees, investments, installments, payments, documents, wallet, alerts } = data;
  const profileTabs = PROFILE_TABS.map((entry) => {
    if (entry.key === 'enrollments') return { ...entry, count: investments.length };
    if (entry.key === 'installments') return { ...entry, count: installments.length };
    if (entry.key === 'payments') return { ...entry, count: payments.length };
    if (entry.key === 'wallet') return { ...entry, count: wallet?.summary?.pending_requests || undefined };
    if (entry.key === 'nominees') return { ...entry, count: nominees.length };
    return entry;
  });

  const saveField = async (field, value) => {
    const clean = String(value ?? '').trim();
    if (!clean) throw new Error('Enter a value, or cancel to keep the current one');
    const payload = field === 'alternate_mobile' ? { [field]: clean } : { [field]: clean };
    await investorsApi.update(id, payload);
    toast.success('Profile updated');
    reload();
  };

  const uploadDocument = async (kind, file) => {
    await investorsApi.uploadDocument(id, kind, file);
    toast.success('Document uploaded - pending verification');
  };

  const reviewDocument = async (kind, payload) => {
    await investorsApi.reviewDocument(id, kind, payload);
    toast.success(`Document ${payload.status.toLowerCase()}`);
  };

  const uploadNomineePhoto = (nomineeId, file) => investorsApi.uploadNomineePhoto(id, nomineeId, file);
  const reviewNomineePhoto = (nomineeId, payload) => investorsApi.reviewNomineePhoto(id, nomineeId, payload);

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

  const decideMembership = async (status, note, { rethrow = false } = {}) => {
    try {
      await investorsApi.decideMembership(id, { status, note });
      toast.success(status === 'APPROVED' ? 'Membership approved' : 'Membership rejected');
      setMembershipDecision(null);
      reload();
    } catch (err) {
      toast.error(err.message);
      if (rethrow) throw err;
    }
  };

  const toggleFreeze = async (frozen, reason) => {
    try {
      await investorsApi.setFrozen(id, { frozen, reason });
      toast.success(frozen ? 'Account frozen - portal sessions revoked' : 'Account unfrozen');
      setFreezeOpen(false);
      reload();
    } catch (err) {
      toast.error(err.message);
      throw err;
    }
  };

  const recordWalletEntry = async (payload) => {
    await investorsApi.recordWalletEntry(id, payload);
    toast.success('Ledger entry posted');
    setWalletEntryOpen(false);
    reload();
  };

  const decideWallet = async (txId, payload) => {
    await investorsApi.decideWallet(id, txId, payload);
    toast.success(payload.decision === 'APPROVE' ? 'Request approved' : 'Request rejected');
    reload();
  };

  const slotsByKind = Object.fromEntries((documents?.slots ?? []).map((slot) => [slot.kind, slot]));
  const nomineePhotos = Object.fromEntries((documents?.nominee_photos ?? []).map((row) => [row.nominee_id, row]));
  const pendingReviews = documents?.pending_review ?? 0;
  const pendingWallet = (wallet?.transactions ?? []).filter((tx) => tx.status === 'PENDING');

  return (
    <>
      <section className="profile-head">
        <div className="photo-frame">
          {investor.has_photo ? (
            <img
              src={`${investorsApi.photoUrl(id)}?v=${encodeURIComponent(slotsByKind.PHOTO?.uploaded_at ?? investor.updated_at ?? '')}`}
              alt={investor.name}
            />
          ) : (
            <span className="avatar huge" style={{ boxShadow: 'none' }}>
              {investor.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')}
            </span>
          )}
        </div>
        <div className="who-main">
          <h1>{investor.name}</h1>
          {investor.name_bangla ? <div className="muted">{investor.name_bangla}</div> : null}
          <div className="who-meta">
            <span className="mono">{investor.member_code}</span> · Member since {formatDate(investor.created_at)}
            {investor.last_login_at ? ` · Last portal login ${formatDateTime(investor.last_login_at)}` : ' · Portal never used'}
          </div>
          <div className="pill-row" style={{ marginTop: 8 }}>
            <Badge status={investor.status} />
            <span className={`badge ${investor.membership_status === 'APPROVED' ? 'ok' : investor.membership_status === 'REJECTED' ? 'danger' : 'warn'}`}>
              Membership {investor.membership_status?.toLowerCase()}
            </span>
            {investor.frozen_at ? <span className="badge danger">Frozen</span> : null}
            {investor.deleted_at ? <span className="badge danger">Deleted {formatDate(investor.deleted_at)}</span> : null}
            {pendingReviews > 0 ? <span className="badge warn">{pendingReviews} document(s) to review</span> : null}
            <span className="badge info">{investor.portal_enabled ? 'Portal enabled' : 'Portal off'}</span>
          </div>
        </div>
        <div className="actions">
          {canWrite ? (
            <>
              <Button className="sm" onClick={() => navigate(`/investors/${id}/edit`)}>Edit</Button>
              <Button className="sm" onClick={() => navigate(`/investments/new?investorId=${id}`)}>+ Pension</Button>
            </>
          ) : null}
          <Button className="sm" title="Print-ready statement - use Print → Save as PDF" onClick={() => reportsApi.statementPrint(id)}>
            PDF statement
          </Button>
          <Button className="sm" title="Print-ready membership certificate" onClick={() => investorsApi.certificatePrint(id)}>
            Certificate
          </Button>
          {isSuperAdmin ? (
            investor.frozen_at ? (
              <Button className="sm" onClick={() => toggleFreeze(false)}>Unfreeze</Button>
            ) : (
              <Button className="sm danger" onClick={() => setFreezeOpen(true)}>
                Freeze account
              </Button>
            )
          ) : null}
        </div>
      </section>

      <AlertBanners
        alerts={alerts}
        onAction={(target) => {
          if (target === 'support') navigate('/support');
          else setTab(target);
        }}
      />

      <TabBar tabs={profileTabs} active={tab} onChange={setTab} />

      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'profile' ? (
          <>
            <div className="grid cols-2">
              <Card title="Identity & contact">
                <p className="section-note">Missing fields can be added inline — no dead “N/A” placeholders.</p>
                <InlineEditField label="Name (Bangla)" field="name_bangla" value={investor.name_bangla} canEdit={canWrite} onSave={saveField} placeholder="যেমন: রহিম উদ্দিন" maxLength={120} />
                <InlineEditField label="Mobile (login)" field="mobile" value={isSuperAdmin ? investor.mobile : maskMobile(investor.mobile)} canEdit={false} />
                <InlineEditField label="Email" field="email" value={investor.email} type="email" canEdit={canWrite} onSave={saveField} placeholder="name@example.com" />
                <InlineEditField label="Alternate mobile" field="alternate_mobile" value={investor.alternate_mobile} canEdit={canWrite} onSave={saveField} placeholder="01712345678" />
                <InlineEditField label="Father / husband" field="father_name" value={investor.father_name} canEdit={canWrite} onSave={saveField} maxLength={120} />
                <InlineEditField label="Mother's name" field="mother_name" value={investor.mother_name} canEdit={canWrite} onSave={saveField} maxLength={120} />
                <InlineEditField label="Date of birth" field="date_of_birth" value={investor.date_of_birth} type="date" canEdit={canWrite} onSave={saveField} display={investor.date_of_birth ? formatDate(investor.date_of_birth) : null} />
                <InlineEditField label="Gender" field="gender" value={investor.gender ?? ''} options={GENDER_OPTIONS} canEdit={canWrite} onSave={(field, value) => saveField(field, value)} display={investor.gender ? investor.gender[0] + investor.gender.slice(1).toLowerCase() : null} />
                <InlineEditField label="Religion" field="religion" value={investor.religion} canEdit={canWrite} onSave={saveField} maxLength={60} />
                <InlineEditField label="Education" field="education" value={investor.education} canEdit={canWrite} onSave={saveField} maxLength={120} />
                <InlineEditField label="Present address" field="present_address" value={investor.present_address ?? investor.address} type="textarea" canEdit={canWrite} onSave={saveField} maxLength={500} />
                <InlineEditField label="Permanent address" field="permanent_address" value={investor.permanent_address} type="textarea" canEdit={canWrite} onSave={saveField} maxLength={500} />
                <div className="stat-line">
                  <span>NID</span>
                  <div className="inline-value" style={{ justifyContent: 'flex-end' }}>
                    {isSuperAdmin ? (
                      <>
                        <strong className="mono">{nid ?? (investor.nid_last4 ? `••••••••${investor.nid_last4}` : 'Not on file')}</strong>
                        {investor.has_nid ? (
                          <Button className="sm ghost" onClick={revealNid} disabled={action.busy}>Reveal</Button>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">Restricted to Super Admin</span>
                    )}
                  </div>
                </div>
                {investor.notes ? (
                  <div className="stat-line">
                    <span>Notes</span>
                    <strong style={{ textAlign: 'right', fontWeight: 500 }}>{investor.notes}</strong>
                  </div>
                ) : null}
                <div className="small muted" style={{ marginTop: 10 }}>
                  Created {formatDateTime(investor.created_at)} · Updated {formatDateTime(investor.updated_at)}
                </div>
              </Card>

              <div className="stack">
                <Card
                  title="Membership & account"
                  actions={
                    <span className={`badge ${investor.membership_status === 'APPROVED' ? 'ok' : investor.membership_status === 'REJECTED' ? 'danger' : 'warn'}`}>
                      {investor.membership_status}
                    </span>
                  }
                >
                  {investor.membership_note ? <p className="small muted">{investor.membership_note}</p> : null}
                  {isSuperAdmin ? (
                    <div className="inline" style={{ marginBottom: 12 }}>
                      {investor.membership_status !== 'APPROVED' ? (
                        <Button className="sm primary" onClick={() => decideMembership('APPROVED')}>Approve membership</Button>
                      ) : null}
                      {investor.membership_status !== 'REJECTED' ? (
                        <Button className="sm danger" onClick={() => setMembershipDecision('REJECTED')}>Reject…</Button>
                      ) : null}
                    </div>
                  ) : (
                    <p className="small muted">Only a Super Admin can approve or reject membership.</p>
                  )}

                  <div className="stat-line"><span>Status</span><strong>{investor.status}</strong></div>
                  <div className="stat-line"><span>Portal access</span><strong>{investor.portal_enabled ? 'Enabled' : 'Disabled'}</strong></div>
                  <div className="stat-line"><span>Account freeze</span><strong>{investor.frozen_at ? `Frozen · ${formatDate(investor.frozen_at)}` : 'Active'}</strong></div>
                  {investor.frozen_reason ? <div className="doc-note">{investor.frozen_reason}</div> : null}
                  <div className="inline" style={{ marginTop: 12 }}>
                    {investor.status === 'ACTIVE' ? (
                      canWrite ? (
                        <ConfirmButton className="btn sm" confirmText="Confirm deactivate" onConfirm={() => changeStatus('INACTIVE')}>Deactivate</ConfirmButton>
                      ) : null
                    ) : canWrite ? (
                      <Button className="sm" onClick={() => changeStatus('ACTIVE')}>Reactivate</Button>
                    ) : null}
                    {canWrite && !investor.deleted_at ? (
                      <ConfirmButton onConfirm={removeInvestor} confirmText="Really delete?">Soft delete</ConfirmButton>
                    ) : null}
                    {investor.deleted_at ? <Button className="sm" onClick={() => investorsApi.restore(id).then(reload)}>Restore</Button> : null}
                  </div>
                </Card>

                <Card title="Quick facts">
                  <div className="stat-line"><span>Total collected</span><strong>{formatBDT(alerts?.summary?.total_paid ?? 0)}</strong></div>
                  <div className="stat-line"><span>Outstanding</span><strong>{formatBDT(alerts?.summary?.outstanding ?? 0)}</strong></div>
                  <div className="stat-line"><span>Wallet balance</span><strong>{formatBDT(wallet?.summary?.balance ?? 0)}</strong></div>
                  <div className="stat-line"><span>Next due</span><strong>{alerts?.summary?.next_due_date ? formatDate(alerts.summary.next_due_date) : '—'}</strong></div>
                  <div className="stat-line"><span>Nominees</span><strong>{nominees.length}/3</strong></div>
                  <div className="stat-line"><span>Open inquiries</span><strong>{alerts?.summary?.open_tickets ?? 0}</strong></div>
                </Card>
              </div>
            </div>

            <Card
              title="Photo & documents"
              actions={<span className="small muted">{pendingReviews ? `${pendingReviews} awaiting review` : 'All reviewed'}</span>}
            >
              <p className="section-note">
                Drag & drop or click any slot. Images are cropped in the browser before upload; NID and signature files are
                stored encrypted and never served from a public folder.
              </p>
              <div className="doc-grid">
                <DocumentSlot
                  kind="PHOTO"
                  label="Photo"
                  slot={slotsByKind.PHOTO}
                  url={investorsApi.documentUrl(id, 'PHOTO')}
                  upload={(file) => uploadDocument('PHOTO', file)}
                  review={(payload) => reviewDocument('PHOTO', payload)}
                  canUpload={canWrite}
                  canReview={isSuperAdmin}
                  onChanged={reload}
                  hint="JPEG or PNG, max 2 MB"
                />
                <DocumentSlot
                  kind="NID_FRONT"
                  label="NID front"
                  slot={slotsByKind.NID_FRONT}
                  url={investorsApi.documentUrl(id, 'NID_FRONT')}
                  upload={(file) => uploadDocument('NID_FRONT', file)}
                  review={(payload) => reviewDocument('NID_FRONT', payload)}
                  canUpload={isSuperAdmin}
                  canReview={isSuperAdmin}
                  onChanged={reload}
                  hint="Encrypted · Super Admin only"
                />
                <DocumentSlot
                  kind="NID_BACK"
                  label="NID back"
                  slot={slotsByKind.NID_BACK}
                  url={investorsApi.documentUrl(id, 'NID_BACK')}
                  upload={(file) => uploadDocument('NID_BACK', file)}
                  review={(payload) => reviewDocument('NID_BACK', payload)}
                  canUpload={isSuperAdmin}
                  canReview={isSuperAdmin}
                  onChanged={reload}
                  hint="Encrypted · Super Admin only"
                />
                <DocumentSlot
                  kind="SIGNATURE"
                  label="Signature"
                  slot={slotsByKind.SIGNATURE}
                  url={investorsApi.documentUrl(id, 'SIGNATURE')}
                  upload={(file) => uploadDocument('SIGNATURE', file)}
                  review={(payload) => reviewDocument('SIGNATURE', payload)}
                  canUpload={isSuperAdmin}
                  canReview={isSuperAdmin}
                  onChanged={reload}
                  hint="JPEG or PNG"
                />
              </div>
            </Card>
          </>
        ) : null}

        {tab === 'enrollments' ? (
          <>
            <div className="inline" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Pension enrollments</h2>
              <div className="spacer" />
              {canWrite ? <Button className="sm primary" onClick={() => navigate(`/investments/new?investorId=${id}`)}>+ New pension</Button> : null}
            </div>
            {investments.length === 0 ? (
              <Card><div className="empty">No pension enrollments yet.</div></Card>
            ) : (
              <div className="grid cols-2">
                {investments.map((investment) => (
                  <div className="package-card" key={investment.id}>
                    <div className="package-head">
                      <div>
                        <div className="package-title">{investment.title || `Pension plan #${investment.id}`}</div>
                        <div className="package-meta">
                          #{investment.id} · {investment.interval?.toLowerCase()} · {investment.installment_count} installments
                        </div>
                      </div>
                      <div className="spacer" />
                      <Badge status={investment.status} />
                    </div>
                    <ProgressBar value={investment.progress_percent ?? 0} label="Collected" />
                    <div className="package-foot">
                      <span>Total {formatBDT(investment.total_amount)}</span>
                      <span>Collected {formatBDT(investment.collected)}</span>
                      <span>Outstanding {formatBDT(investment.outstanding)}</span>
                    </div>
                    <div className="package-foot">
                      <span>Next due: {investment.next_due_date ? `${formatDate(investment.next_due_date)} (${dueLabel(investment.next_due_date)})` : '—'}</span>
                      <Link to={`/investments/${investment.id}`}>Open plan →</Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {tab === 'installments' ? (
          <Card
            title="Pension installments"
            actions={<span className="small muted">{alerts?.summary?.overdue_count ? `${alerts.summary.overdue_count} overdue` : 'On schedule'}</span>}
          >
            <Table
              rows={installments}
              empty="No installments yet."
              columns={[
                {
                  key: 'serial',
                  header: 'Installment',
                  render: (row) => (
                    <span>
                      <strong>#{row.serial}</strong> <Link className="small" to={`/investments/${row.investment_id}`}>plan #{row.investment_id}</Link>
                    </span>
                  ),
                },
                {
                  key: 'due_date',
                  header: 'Due date',
                  render: (row) => (
                    <>
                      {formatDate(row.due_date)}{' '}
                      <span className="small muted">({dueLabel(row.due_date)})</span>
                    </>
                  ),
                },
                { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                { key: 'amount_paid', header: 'Paid', align: 'right', render: (row) => formatBDT(row.amount_paid) },
                { key: 'outstanding', header: 'Outstanding', align: 'right', render: (row) => formatBDT(row.outstanding) },
                {
                  key: 'late',
                  header: 'Late fee',
                  render: (row) => {
                    if (!['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status)) return '—';
                    const days = relativeDays(row.due_date);
                    if (days === null || days >= 0) return <span className="muted small">—</span>;
                    return <span className="badge warn">{Math.abs(days)} days late · fee may apply</span>;
                  },
                },
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
                    canWrite && ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status ?? row.status) ? (
                      <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                        <Button className="sm" onClick={() => sendLink(row)}>Send link</Button>
                        <Button className="sm" onClick={() => setPayModal(row)}>Record payment</Button>
                      </div>
                    ) : null,
                },
              ]}
            />
          </Card>
        ) : null}

        {tab === 'wallet' ? (
          <>
            <WalletCard
              summary={wallet?.summary}
              title="Investor wallet"
              subtitle={`Live ledger · ${investor.member_code}`}
              actions={
                canWrite ? (
                  <Button className="sm light" onClick={() => setWalletEntryOpen(true)}>Manual ledger entry</Button>
                ) : null
              }
            />
            <Card title="Pending deposit & withdrawal requests" actions={<span className="small muted">{pendingWallet.length} pending</span>}>
              {pendingWallet.length === 0 ? (
                <div className="empty">No pending wallet requests.</div>
              ) : canWrite ? (
                <WalletRequests transactions={pendingWallet} onDecide={decideWallet} />
              ) : (
                <Table
                  rows={pendingWallet}
                  empty="No pending wallet requests."
                  columns={[
                    { key: 'requested_at', header: 'Requested', render: (row) => formatDateTime(row.requested_at ?? row.created_at) },
                    { key: 'type_label', header: 'Type', render: (row) => row.type_label ?? row.type },
                    { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                    { key: 'status', header: 'Status', render: (row) => <Badge label={row.status_label ?? row.status} status={row.status} /> },
                  ]}
                />
              )}
            </Card>
            <Card title="Recent wallet activity">
              <WalletLedger transactions={(wallet?.transactions ?? []).slice(0, 10)} />
            </Card>
          </>
        ) : null}

        {tab === 'transactions' ? (
          <Card
            title="Wallet transactions"
            actions={canWrite ? <Button className="sm" onClick={() => setWalletEntryOpen(true)}>+ Manual entry</Button> : null}
          >
            <WalletLedger transactions={wallet?.transactions ?? []} />
          </Card>
        ) : null}

        {tab === 'payments' ? (
          <Card title="Payments">
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
                  render: (row) =>
                    row.status === 'SUCCESS' ? (
                      <Button className="sm ghost" onClick={() => paymentsApi.openReceipt(row.id)}>Receipt</Button>
                    ) : null,
                },
              ]}
            />
          </Card>
        ) : null}

        {tab === 'nominees' ? (
          <Card
            title={`Nominees (${nominees.length}/3)`}
            actions={
              isSuperAdmin ? (
                <Button className="sm" onClick={() => navigate(`/investors/${id}/edit`)}>Manage nominees</Button>
              ) : (
                <span className="small muted">Super Admin only</span>
              )
            }
          >
            {nominees.length === 0 ? (
              <div className="empty">No nominees recorded yet.</div>
            ) : (
              <div className="grid cols-3">
                {nominees.map((nominee) => {
                  const photo = nomineePhotos[nominee.id];
                  return (
                    <div key={nominee.id} className="stack" style={{ gap: 10 }}>
                      <DocumentSlot
                        kind="NOMINEE_PHOTO"
                        label={`Photo · ${nominee.name}`}
                        nomineeId={nominee.id}
                        slot={photo ? { ...photo, has_file: photo.has_file } : { has_file: false, status: 'MISSING' }}
                        url={investorsApi.nomineePhotoUrl(id, nominee.id)}
                        upload={(file) => uploadNomineePhoto(nominee.id, file)}
                        review={(payload) => reviewNomineePhoto(nominee.id, payload)}
                        canUpload={canWrite}
                        canReview={isSuperAdmin}
                        onChanged={reload}
                      />
                      <div className="card" style={{ margin: 0 }}>
                        <div className="inline">
                          <strong>{nominee.name}</strong>
                          <span className="badge brand">{nominee.share_percent}%</span>
                          <div className="spacer" />
                          <span className="small muted">{nominee.relation}</span>
                        </div>
                        <div className="small muted" style={{ marginTop: 4 }}>
                          <span className="mono">{isSuperAdmin ? nominee.mobile : maskMobile(nominee.mobile)}</span>
                          {nominee.nid_last4 ? ` · NID ••••${nominee.nid_last4}` : ''}
                        </div>
                        <ProgressBar value={nominee.share_percent} label="Allocation" />
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
                            Reveal NID
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {nominees.length ? (
              <div className="small muted" style={{ marginTop: 12 }}>
                Total allocation{' '}
                {nominees.reduce((sum, nominee) => sum + Number(nominee.share_percent || 0), 0)}% (must equal 100%).
              </div>
            ) : null}
          </Card>
        ) : null}

        {tab === 'password' ? <PortalAccessCard investorId={id} canManage={canWrite} /> : null}
      </div>

      {linkModal ? (
        <Modal title="Payment link" onClose={() => setLinkModal(null)} footer={<Button onClick={() => setLinkModal(null)}>Close</Button>}>
          <p className="muted small">
            Installment #{linkModal.installment.serial} · {formatBDT(linkModal.installment.amount)} · due {formatDate(linkModal.installment.due_date)}
          </p>
          <div className="code-box">{linkModal.url}</div>
          <p className="small">{linkModal.sent ? '✓ Sent by SMS to the investor.' : 'SMS was not delivered; copy the link above.'}</p>
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

      {payModal ? (
        <ManualPaymentModal
          installment={payModal}
          onClose={() => setPayModal(null)}
          onDone={() => {
            setPayModal(null);
            reload();
          }}
        />
      ) : null}

      {walletEntryOpen ? <WalletEntryModal onClose={() => setWalletEntryOpen(false)} onSubmit={recordWalletEntry} /> : null}

      {freezeOpen ? (
        <FreezeModal
          investor={investor}
          onClose={() => setFreezeOpen(false)}
          onSubmit={(reason) => toggleFreeze(true, reason)}
        />
      ) : null}

      {membershipDecision ? (
        <MembershipModal
          status={membershipDecision}
          onClose={() => setMembershipDecision(null)}
          onSubmit={(note) => decideMembership(membershipDecision, note, { rethrow: true })}
        />
      ) : null}
    </>
  );
}

function FreezeModal({ investor, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <Modal title={`Freeze ${investor.name}?`} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!reason.trim()) {
            setError('Explain why the account is being frozen');
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await onSubmit(reason.trim());
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="small muted">
          Freezing blocks wallet withdrawals and payment links, and signs the investor out of the portal. The ledger and
          history are preserved.
        </p>
        {error ? <div className="alert error">{error}</div> : null}
        <Field label="Reason" error={error}>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} autoFocus />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Freezing…' : 'Freeze account'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function MembershipModal({ status, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <Modal title={status === 'APPROVED' ? 'Approve membership' : 'Reject membership'} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (status === 'REJECTED' && !note.trim()) {
            setError('Add a reason so the member knows what to fix');
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await onSubmit(note.trim() || undefined);
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={status === 'REJECTED' ? 'Reason (required)' : 'Note (optional)'} error={error}>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} autoFocus />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={status === 'APPROVED' ? 'primary' : 'danger'} size="sm" disabled={busy}>
            {busy ? 'Saving…' : status === 'APPROVED' ? 'Approve' : 'Reject membership'}
          </Button>
        </div>
      </form>
    </Modal>
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
          Outstanding: <strong>{formatBDT(Number(installment.amount) - Number(installment.amount_paid || 0))}</strong> · due{' '}
          {formatDate(installment.due_date)}
        </p>
        <Field label="Amount (BDT)">
          <Input required value={amount} onChange={setAmount} inputMode="decimal" />
        </Field>
        <div className="form-row">
          <Field label="Method">
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
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
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        </Field>
        <label className="inline small">
          <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} /> Send SMS confirmation
        </label>
        <div className="inline" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Investor portal access: status, temporary password issue/reset,
 * enable/disable and session revoke. The plaintext password is shown exactly
 * once so staff can hand it over; it is never retrievable afterwards.
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
      <Card title="Portal access">
        <Spinner />
      </Card>
    );
  }
  if (error || !data?.portal) {
    return (
      <Card title="Portal access">
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
    <Card title="Change portal password">
      <p className="section-note">
        The member signs in with their mobile number or member code. Resetting the password signs them out everywhere and
        forces a change at next sign-in.
      </p>
      <div className="stat-line">
        <span>Status</span>
        <div className="inline">
          {portal.portal_enabled ? <span className="badge ok">Enabled</span> : portal.has_password ? <span className="badge muted">Disabled</span> : <span className="badge warn">Not set up</span>}
          {portal.must_change_password ? <span className="badge warn">Temporary password</span> : null}
          {locked ? <span className="badge danger">Locked until {formatDateTime(portal.locked_until)}</span> : null}
        </div>
      </div>
      <div className="stat-line"><span>Login id</span><strong className="mono">{portal.mobile} · {portal.member_code}</strong></div>
      <div className="stat-line"><span>Login page</span><strong className="mono small">{portal.login_url}</strong></div>
      <div className="stat-line"><span>Last login</span><strong>{portal.last_login_at ? formatDateTime(portal.last_login_at) : 'Never'}</strong></div>
      <div className="stat-line"><span>Active sessions</span><strong>{portal.active_sessions}{portal.failed_login_count ? ` · ${portal.failed_login_count} failed attempt(s)` : ''}</strong></div>

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
            <Button className="sm ghost" disabled={busy} onClick={() => run(() => investorsApi.revokePortalSessions(investorId), 'Investor signed out everywhere')}>
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
                <Button className="sm primary" onClick={() => setPasswordModal(false)}>Done</Button>
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
                <input type="checkbox" checked={sendSms} onChange={(event) => setSendSms(event.target.checked)} /> Send credentials by SMS to {portal.mobile}
              </label>
              <p className="muted small" style={{ marginTop: 10 }}>
                Setting a password enables portal access, signs the investor out everywhere, clears any lock, and forces a
                password change at first sign-in.
              </p>
              <div className="inline" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
                <Button type="button" className="sm" onClick={() => setPasswordModal(false)}>Cancel</Button>
                <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Saving…' : portal.has_password ? 'Reset password' : 'Set password & enable'}</Button>
              </div>
            </form>
          )}
        </Modal>
      ) : null}
    </Card>
  );
}
