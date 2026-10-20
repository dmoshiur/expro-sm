import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  ProgressBar,
  Spinner,
  TabBar,
  Table,
} from '../../components/ui.jsx';
import { DocumentSlot } from '../../components/DocumentSlot.jsx';
import { InlineEditField } from '../../components/InlineEdit.jsx';
import { WalletCard, WalletLedger, WalletRequestModal } from '../../components/WalletCard.jsx';
import { AlertBanners } from '../../components/AlertBanners.jsx';
import { PROFILE_TABS, normaliseTab } from '../profileTabs.js';
import { formatBDT, formatDate, formatDateTime, dueLabel, relativeDays } from '../../utils/format.js';

const GENDER_OPTIONS = [
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'OTHER', label: 'Other' },
];

export function PortalProfile() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = normaliseTab(searchParams.get('tab'));
  const setTab = (key) => setSearchParams({ tab: key });
  const [walletModal, setWalletModal] = useState(null);
  const [payingId, setPayingId] = useState(null);

  const profileApi = useApi(() => portalApi.profile(), []);
  const walletApi = useApi(() => portalApi.wallet(), []);
  const enrollmentsApi = useApi(() => portalApi.investments(), []);
  const installmentsApi = useApi(() => portalApi.installments(), []);
  const paymentsApi = useApi(() => portalApi.payments(), []);
  useRefreshOnFocus(() => { profileApi.reload(); walletApi.reload(); }, { intervalMs: 60000 });

  if (profileApi.error) return <Alert tone="error">{profileApi.error.message}</Alert>;
  if (profileApi.loading || !profileApi.data) return <Spinner />;

  const { profile, completion, documents, alerts } = profileApi.data;
  const wallet = walletApi.data?.summary ?? profileApi.data.wallet ?? null;
  const walletTransactions = walletApi.data?.transactions ?? [];
  const enrollments = enrollmentsApi.data?.investments ?? [];
  const installments = installmentsApi.data?.installments ?? [];
  const payments = paymentsApi.data?.payments ?? [];
  const nominees = profile.nominees ?? [];
  const slotsByKind = Object.fromEntries((documents?.slots ?? []).map((slot) => [slot.kind, slot]));
  const nomineePhotos = Object.fromEntries((documents?.nominee_photos ?? []).map((row) => [row.nominee_id, row]));
  const pendingWallet = walletTransactions.filter((tx) => tx.status === 'PENDING');

  const tabs = PROFILE_TABS.map((entry) => {
    if (entry.key === 'enrollments') return { ...entry, count: enrollments.length };
    if (entry.key === 'installments') return { ...entry, count: installments.length };
    if (entry.key === 'payments') return { ...entry, count: payments.length };
    if (entry.key === 'wallet') return { ...entry, count: pendingWallet.length || undefined };
    if (entry.key === 'nominees') return { ...entry, count: nominees.length };
    return entry;
  });

  const refreshAll = () => {
    profileApi.reload();
    walletApi.reload();
    enrollmentsApi.reload();
    installmentsApi.reload();
    paymentsApi.reload();
  };

  const saveField = async (field, value) => {
    const clean = String(value ?? '').trim();
    if (!clean) throw new Error('Enter a value, or cancel to keep the current one');
    await portalApi.updateProfile({ [field]: clean });
    toast.success('Profile updated');
    refreshAll();
  };

  const uploadDocument = async (kind, file) => {
    await portalApi.uploadDocument(kind, file);
    toast.success('Document uploaded - the office will verify it');
    refreshAll();
  };

  const uploadNomineePhoto = async (nomineeId, file) => {
    await portalApi.uploadNomineePhoto(nomineeId, file);
    toast.success('Nominee photo uploaded');
    refreshAll();
  };

  const requestWallet = async (payload) => {
    await portalApi.requestWallet(payload);
    toast.success(payload.type === 'WITHDRAWAL' ? 'Withdrawal request sent' : 'Deposit request sent');
    setWalletModal(null);
    refreshAll();
  };

  const payNow = async (row) => {
    setPayingId(row.id);
    try {
      const link = await portalApi.payLink(row.id);
      navigate(link.path);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPayingId(null);
    }
  };

  return (
    <>
      <section className="profile-head">
        <div className="photo-frame">
          {profile.has_photo ? (
            <img src={`${portalApi.photoUrl}?v=${profile.last_login_at ?? ''}`} alt={profile.name} />
          ) : (
            <span className="avatar huge" style={{ boxShadow: 'none' }}>
              {profile.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')}
            </span>
          )}
        </div>
        <div className="who-main">
          <h1>{profile.name}</h1>
          {profile.name_bangla ? <div className="muted">{profile.name_bangla}</div> : null}
          <div className="who-meta">
            <span className="mono">{profile.member_code}</span> · Member since {formatDate(profile.member_since)} ·{' '}
            {profile.mobile}
          </div>
          <div className="pill-row" style={{ marginTop: 8 }}>
            <Badge status={profile.status} />
            <span className={`badge ${profile.membership_status === 'APPROVED' ? 'ok' : profile.membership_status === 'REJECTED' ? 'danger' : 'warn'}`}>
              Membership {String(profile.membership_status).toLowerCase()}
            </span>
            {profile.is_frozen ? <span className="badge danger">Account frozen</span> : null}
            {pendingWallet.length ? <span className="badge warn">{pendingWallet.length} wallet request(s) pending</span> : null}
          </div>
        </div>
        <div className="actions">
          <Button className="sm" title="Print-ready statement - use Print → Save as PDF" onClick={() => portalApi.statementPrint()}>
            PDF statement
          </Button>
          <Button className="sm" title="Print-ready membership certificate" onClick={() => portalApi.certificate()}>
            Certificate
          </Button>
          <Button className="sm" onClick={() => navigate('/portal/support')}>Support</Button>
        </div>
      </section>

      {profile.is_frozen ? (
        <Alert tone="error">
          Your account is frozen{profile.frozen_reason ? `: ${profile.frozen_reason}` : ''}. Wallet withdrawals and payment
          links are blocked until the office lifts the freeze. Your records remain available.
        </Alert>
      ) : null}

      <AlertBanners
        alerts={alerts}
        onAction={(target) => {
          if (target === 'support') navigate('/portal/support');
          else setTab(target === 'installments' ? 'installments' : target === 'wallet' ? 'wallet' : 'profile');
        }}
      />

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'profile' ? (
          <>
            <div className="grid cols-2">
              <Card title="Personal information">
                <p className="section-note">Tap any missing field to add it. No more “N/A”.</p>
                <InlineEditField label="Name (Bangla)" field="name_bangla" value={profile.name_bangla} canEdit onSave={saveField} placeholder="যেমন: রহিম উদ্দিন" maxLength={120} />
                <InlineEditField label="Full name" field="name" value={profile.name} canEdit={false} />
                <InlineEditField label="Mobile (login)" field="mobile" value={profile.mobile} canEdit={false} />
                <InlineEditField label="Father / husband" field="father_name" value={profile.father_name} canEdit onSave={saveField} maxLength={120} />
                <InlineEditField label="Mother's name" field="mother_name" value={profile.mother_name} canEdit onSave={saveField} maxLength={120} />
                <InlineEditField label="Date of birth" field="date_of_birth" value={profile.date_of_birth} type="date" canEdit onSave={saveField} display={profile.date_of_birth ? formatDate(profile.date_of_birth) : null} />
                <InlineEditField label="Gender" field="gender" value={profile.gender ?? ''} options={GENDER_OPTIONS} canEdit onSave={(field, value) => saveField(field, value)} display={profile.gender ? profile.gender[0] + profile.gender.slice(1).toLowerCase() : null} />
                <InlineEditField label="Religion" field="religion" value={profile.religion} canEdit onSave={saveField} maxLength={60} />
                <InlineEditField label="Education" field="education" value={profile.education} canEdit onSave={saveField} maxLength={120} />
                <InlineEditField label="Email" field="email" value={profile.email} type="email" canEdit onSave={saveField} placeholder="you@example.com" />
                <InlineEditField label="Alternate mobile" field="alternate_mobile" value={profile.alternate_mobile} canEdit onSave={saveField} placeholder="01712345678" />
                <InlineEditField label="Present address" field="present_address" value={profile.present_address} type="textarea" canEdit onSave={saveField} maxLength={500} />
                <InlineEditField label="Permanent address" field="permanent_address" value={profile.permanent_address} type="textarea" canEdit onSave={saveField} maxLength={500} />
                <div className="stat-line">
                  <span>NID</span>
                  <strong className="mono">{profile.nid_last4 ? `••••••••${profile.nid_last4}` : 'Not on file'}</strong>
                </div>
                <p className="small muted" style={{ marginTop: 8 }}>
                  Name, mobile and NID are changed by the office to protect your account. Everything else is yours to
                  complete.
                </p>
              </Card>

              <div className="stack">
                <Card title="Profile completeness">
                  <ProgressBar value={completion.percent} label={`${completion.done}/${completion.total} details complete`} size="lg" />
                  {completion.missing.length ? (
                    <div className="stack small" style={{ marginTop: 10 }}>
                      <span className="muted">Still missing:</span>
                      <div className="pill-row">
                        {completion.missing.map((item) => (
                          <span key={item.key} className="badge warn">{item.label}</span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="small" style={{ marginTop: 10 }}>✓ Your profile is complete. Thank you!</p>
                  )}
                </Card>

                <Card title="Membership">
                  <div className="stat-line"><span>Status</span><strong>{profile.membership_status}</strong></div>
                  {profile.membership_note ? <div className="doc-note">{profile.membership_note}</div> : null}
                  <div className="stat-line"><span>Member code</span><strong className="mono">{profile.member_code}</strong></div>
                  <div className="stat-line"><span>Member since</span><strong>{formatDate(profile.member_since)}</strong></div>
                  <div className="stat-line"><span>Last login</span><strong>{profile.last_login_at ? formatDateTime(profile.last_login_at) : '—'}</strong></div>
                  <div className="inline" style={{ marginTop: 12 }}>
                    <Button className="sm" onClick={() => portalApi.certificate()}>Membership certificate (PDF)</Button>
                    <Button className="sm ghost" onClick={() => portalApi.statementPrint()}>Investment statement (PDF)</Button>
                  </div>
                </Card>
              </div>
            </div>

            <Card
              title="Photo & documents"
              actions={<span className="small muted">{documents?.pending_review ? `${documents.pending_review} awaiting verification` : 'All reviewed'}</span>}
            >
              <p className="section-note">
                Drag & drop or click to upload. Photos and signatures are cropped in your browser before upload; NID files
                are stored encrypted and only the office can open them.
              </p>
              <div className="doc-grid">
                <DocumentSlot kind="PHOTO" label="Photo" slot={slotsByKind.PHOTO} url={portalApi.documentUrl('PHOTO')} upload={(file) => uploadDocument('PHOTO', file)} canUpload onChanged={refreshAll} hint="JPEG or PNG, max 2 MB" />
                <DocumentSlot kind="NID_FRONT" label="NID front" slot={slotsByKind.NID_FRONT} url={portalApi.documentUrl('NID_FRONT')} upload={(file) => uploadDocument('NID_FRONT', file)} canUpload onChanged={refreshAll} hint="Encrypted · JPEG/PNG/PDF" />
                <DocumentSlot kind="NID_BACK" label="NID back" slot={slotsByKind.NID_BACK} url={portalApi.documentUrl('NID_BACK')} upload={(file) => uploadDocument('NID_BACK', file)} canUpload onChanged={refreshAll} hint="Encrypted · JPEG/PNG/PDF" />
                <DocumentSlot kind="SIGNATURE" label="Signature" slot={slotsByKind.SIGNATURE} url={portalApi.documentUrl('SIGNATURE')} upload={(file) => uploadDocument('SIGNATURE', file)} canUpload onChanged={refreshAll} hint="JPEG or PNG" />
              </div>
            </Card>
          </>
        ) : null}

        {tab === 'enrollments' ? (
          <>
            <div className="inline" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>My pension enrollments</h2>
              <div className="spacer" />
              <span className="small muted">Live progress from the ledger</span>
            </div>
            {enrollmentsApi.loading ? (
              <Spinner />
            ) : enrollments.length === 0 ? (
              <Card><div className="empty">You have no pension enrollments yet. Please contact the office.</div></Card>
            ) : (
              <div className="grid cols-2">
                {enrollments.map((investment) => (
                  <div className="package-card" key={investment.id}>
                    <div className="package-head">
                      <div>
                        <div className="package-title">{investment.title || `Pension plan #${investment.id}`}</div>
                        <div className="package-meta">
                          {investment.installment_count} installments · {investment.interval?.toLowerCase()}
                        </div>
                      </div>
                      <div className="spacer" />
                      <Badge status={investment.status} />
                    </div>
                    <ProgressBar
                      value={investment.progress_percent ?? 0}
                      label={`${investment.paid_installments}/${investment.installment_count} installments paid`}
                      tone={investment.overdue_installments > 0 ? 'warn' : ''}
                    />
                    <div className="package-foot">
                      <span>Total {formatBDT(investment.total_amount)}</span>
                      <span>Paid {formatBDT(investment.collected)}</span>
                      <span>Remaining {formatBDT(investment.outstanding)}</span>
                    </div>
                    <div className="package-foot">
                      <span>Next due: {investment.next_due_date ? `${formatDate(investment.next_due_date)} (${dueLabel(investment.next_due_date)})` : '—'}</span>
                      {investment.overdue_installments > 0 ? (
                        <span className="badge warn">{investment.overdue_installments} overdue</span>
                      ) : (
                        <span className="badge ok">On track</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {tab === 'installments' ? (
          <Card
            title="My installment schedule"
            actions={<span className="small muted">{alerts?.summary?.overdue_count ? `${alerts.summary.overdue_count} overdue` : 'On schedule'}</span>}
          >
            {installmentsApi.loading ? (
              <Spinner />
            ) : (
              <Table
                rows={installments}
                empty="No installments yet."
                columns={[
                  { key: 'serial', header: 'Installment', render: (row) => <><strong>#{row.serial}</strong> <span className="small muted">{row.investment_title || `plan #${row.investment_id}`}</span></> },
                  { key: 'due_date', header: 'Due date', render: (row) => <>{formatDate(row.due_date)} <span className="small muted">({dueLabel(row.due_date)})</span></> },
                  { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                  { key: 'outstanding', header: 'Due', align: 'right', render: (row) => formatBDT(row.outstanding) },
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
                  { key: 'status', header: 'Status', render: (row) => <Badge status={row.effective_status ?? row.status} /> },
                  {
                    key: 'pay',
                    header: '',
                    align: 'right',
                    render: (row) =>
                      ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status ?? row.status) ? (
                        <Button className="sm primary" disabled={payingId === row.id} onClick={() => payNow(row)}>
                          {payingId === row.id ? 'Opening…' : 'Pay now'}
                        </Button>
                      ) : null,
                  },
                ]}
              />
            )}
          </Card>
        ) : null}

        {tab === 'wallet' ? (
          <>
            <WalletCard
              summary={wallet}
              title="My wallet"
              subtitle="Live balance from the office ledger"
              actions={
                profile.is_frozen ? (
                  <span className="wallet-sub">Frozen — requests are disabled</span>
                ) : (
                  <>
                    <Button className="sm light" onClick={() => setWalletModal('DEPOSIT')}>Deposit</Button>
                    <Button className="sm" onClick={() => setWalletModal('WITHDRAWAL')}>Withdraw</Button>
                  </>
                )
              }
            />
            <Card title="My requests" actions={<span className="small muted">{pendingWallet.length} pending</span>}>
              {pendingWallet.length === 0 ? (
                <div className="empty">No pending wallet requests.</div>
              ) : (
                <div className="stack">
                  {pendingWallet.map((tx) => (
                    <div key={tx.id} className="stat-line">
                      <span>
                        {tx.type_label ?? tx.type} · {formatDateTime(tx.requested_at)}
                      </span>
                      <strong>{formatBDT(tx.amount)} <span className="badge warn">Pending</span></strong>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Request history" actions={<span className="small muted">Deposits & withdrawals</span>}>
              {walletApi.loading ? (
                <Spinner />
              ) : (
                <Table
                  rows={walletTransactions.filter((tx) => tx.type === 'DEPOSIT' || tx.type === 'WITHDRAWAL')}
                  empty="No deposit or withdrawal requests yet."
                  columns={[
                    { key: 'requested_at', header: 'Requested', render: (row) => formatDateTime(row.requested_at ?? row.created_at) },
                    { key: 'type_label', header: 'Type', render: (row) => row.type_label ?? row.type },
                    { key: 'reference', header: 'Reference', mono: true, render: (row) => row.reference },
                    { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (row) => (
                        <span className={`badge ${row.status === 'COMPLETED' ? 'ok' : row.status === 'REJECTED' ? 'danger' : 'warn'}`}>
                          {row.status === 'COMPLETED' ? 'Approved' : row.status === 'REJECTED' ? 'Rejected' : 'Pending'}
                        </span>
                      ),
                    },
                    { key: 'review', header: 'Office note', render: (row) => row.review_note ?? row.note ?? '—' },
                  ]}
                />
              )}
            </Card>
            <Card title="Wallet activity">
              {walletApi.loading ? <Spinner /> : <WalletLedger transactions={walletTransactions} />}
            </Card>
          </>
        ) : null}

        {tab === 'transactions' ? (
          <Card title="Wallet transactions">
            {walletApi.loading ? <Spinner /> : <WalletLedger transactions={walletTransactions} />}
          </Card>
        ) : null}

        {tab === 'payments' ? (
          <Card title="My payments">
            {paymentsApi.loading ? (
              <Spinner />
            ) : (
              <Table
                rows={payments}
                empty="No payments yet."
                columns={[
                  { key: 'paid_at', header: 'Date', render: (row) => (row.paid_at ? formatDateTime(row.paid_at) : formatDateTime(row.created_at)) },
                  { key: 'installment_serial', header: 'Installment', render: (row) => `#${row.installment_serial}` },
                  { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
                  { key: 'method', header: 'Method' },
                  { key: 'trx_id', header: 'Trx / Ref', mono: true, render: (row) => row.trx_id || row.manual_reference || '—' },
                  { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
                  {
                    key: 'receipt',
                    header: '',
                    align: 'right',
                    render: (row) => (row.status === 'SUCCESS' ? <Button className="sm ghost" onClick={() => portalApi.openReceipt(row.id)}>Receipt</Button> : null),
                  },
                ]}
              />
            )}
          </Card>
        ) : null}

        {tab === 'nominees' ? (
          <Card title={`My nominees (${nominees.length}/3)`} actions={<span className="small muted">Shares must total 100%</span>}>
            {nominees.length === 0 ? (
              <div className="empty">No nominees recorded. Please open a support inquiry so the office can add them.</div>
            ) : (
              <div className="grid cols-3">
                {nominees.map((nominee) => {
                  const photo = nomineePhotos[nominee.id];
                  return (
                    <div className="stack" key={nominee.id} style={{ gap: 10 }}>
                      <DocumentSlot
                        kind="NOMINEE_PHOTO"
                        label={`Photo · ${nominee.name}`}
                        nomineeId={nominee.id}
                        slot={photo ?? { has_file: false, status: 'MISSING' }}
                        url={portalApi.nomineePhotoUrl(nominee.id)}
                        upload={(file) => uploadNomineePhoto(nominee.id, file)}
                        canUpload
                        onChanged={refreshAll}
                      />
                      <div className="card" style={{ margin: 0 }}>
                        <div className="inline">
                          <strong>{nominee.name}</strong>
                          <span className="badge brand">{nominee.share_percent}%</span>
                          <div className="spacer" />
                          <span className="small muted">{nominee.relation}</span>
                        </div>
                        <div className="small muted mono" style={{ marginTop: 4 }}>
                          {nominee.mobile}
                          {nominee.nid_last4 ? ` · NID ••••${nominee.nid_last4}` : ''}
                        </div>
                        <ProgressBar value={nominee.share_percent} label="Allocation" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="small muted" style={{ marginTop: 12 }}>
              You can upload a photo for each nominee. Name, relation, NID and share changes are made by the office after
              identity verification - <Link to="/portal/support">open an inquiry</Link> to request a change.
            </p>
          </Card>
        ) : null}

        {tab === 'password' ? <PortalPasswordCard /> : null}
      </div>

      {walletModal ? <WalletRequestModal type={walletModal} onClose={() => setWalletModal(null)} onSubmit={requestWallet} /> : null}
    </>
  );
}

function PortalPasswordCard() {
  const toast = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState(null);
  const me = useApi(() => portalApi.me(), []);
  const sessionsValue = sessions ?? me.data?.sessions ?? [];

  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (!form.currentPassword) nextErrors.currentPassword = 'Enter your current password';
    if (form.newPassword.length < 8) nextErrors.newPassword = 'Use at least 8 characters with a letter and a digit';
    if (!/[a-z]/i.test(form.newPassword) || !/\d/.test(form.newPassword)) nextErrors.newPassword = 'Use at least one letter and one digit';
    if (form.newPassword !== form.confirmPassword) nextErrors.confirmPassword = 'Passwords do not match';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await portalApi.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password changed - other devices were signed out');
      me.reload();
    } catch (err) {
      setErrors(err.details ?? { form: err.message });
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async () => {
    try {
      await portalApi.revokeOtherSessions();
      toast.success('Other sessions signed out');
      setSessions([]);
      me.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="grid cols-2">
      <Card title="Change my password">
        <p className="section-note">
          Your password protects your wallet and pension records. Use at least 8 characters with a letter and a digit.
        </p>
        {errors.form ? <div className="alert error">{errors.form}</div> : null}
        <form onSubmit={submit}>
          <Field label="Current password" error={errors.currentPassword}>
            <Input type="password" value={form.currentPassword} onChange={(value) => setForm((c) => ({ ...c, currentPassword: value }))} autoComplete="current-password" />
          </Field>
          <Field label="New password" error={errors.newPassword}>
            <Input type="password" value={form.newPassword} onChange={(value) => setForm((c) => ({ ...c, newPassword: value }))} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password" error={errors.confirmPassword}>
            <Input type="password" value={form.confirmPassword} onChange={(value) => setForm((c) => ({ ...c, confirmPassword: value }))} autoComplete="new-password" />
          </Field>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
        </form>
      </Card>

      <Card title="My sessions">
        <p className="section-note">Every device signed in to your account. Sign out anything you do not recognise.</p>
        <Table
          rows={sessionsValue}
          empty="No other sessions."
          columns={[
            { key: 'created_at', header: 'Signed in', render: (row) => formatDateTime(row.created_at) },
            { key: 'ip', header: 'IP', mono: true, render: (row) => row.ip || '—' },
            { key: 'user_agent', header: 'Device', render: (row) => <span className="small muted">{String(row.user_agent ?? '—').slice(0, 48)}</span> },
            { key: 'current', header: '', align: 'right', render: (row) => (row.current ? <span className="badge ok">This device</span> : null) },
          ]}
        />
        <Button className="sm" style={{ marginTop: 12 }} onClick={revokeOthers}>Sign out other devices</Button>
      </Card>
    </div>
  );
}
