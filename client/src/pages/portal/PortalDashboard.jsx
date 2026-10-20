import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Kpi, ProgressBar, Spinner, Table } from '../../components/ui.jsx';
import { WalletCard } from '../../components/WalletCard.jsx';
import { AlertBanners } from '../../components/AlertBanners.jsx';
import { PensionProgress } from '../../components/PensionProgress.jsx';
import { formatBDT, formatDate, formatDateTime, dueLabel } from '../../utils/format.js';

export function PortalDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useApi(() => portalApi.dashboard(), []);
  useRefreshOnFocus(reload, { intervalMs: 60000 });
  const [payingId, setPayingId] = useState(null);

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const { profile, completion, summary, wallet, alerts, upcoming_installments: upcoming, recent_payments: recent } = data;

  const payNow = async (installment) => {
    setPayingId(installment.id);
    try {
      const link = await portalApi.payLink(installment.id);
      navigate(link.path);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPayingId(null);
    }
  };

  const firstName = profile.name.split(' ')[0];
  const initials = profile.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <>
      <section className="profile-head hero" style={{ marginBottom: 16 }}>
        <div className="photo-frame">
          {profile.has_photo ? (
            <img src={`${portalApi.photoUrl}?v=${encodeURIComponent(profile.last_login_at ?? '')}`} alt="My photo" />
          ) : (
            <span className="avatar big" style={{ boxShadow: 'none' }}>
              {initials}
            </span>
          )}
        </div>
        <div className="who-main">
          <div className="small" style={{ fontWeight: 600 }}>Welcome back</div>
          <h1>Hello, {firstName}</h1>
          <div className="who-meta">
            <span className="mono">{profile.member_code}</span> · Member since {formatDate(profile.member_since)}
            {profile.last_login_at ? <> · Last login {formatDateTime(profile.last_login_at)}</> : null}
          </div>
          <div className="pill-row" style={{ marginTop: 8 }}>
            <Badge status={profile.status} />
            <span className={`badge ${profile.membership_status === 'APPROVED' ? 'ok' : 'warn'}`}>
              Membership {String(profile.membership_status).toLowerCase()}
            </span>
            {profile.is_frozen ? <span className="badge danger">Account frozen</span> : null}
          </div>
        </div>
        <div className="actions">
          <Button className="sm primary" onClick={() => navigate('/portal/digital-id')}>Digital ID</Button>
          <Button className="sm" title="Print-ready statement - use Print → Save as PDF" onClick={() => portalApi.statementPrint()}>
            Statement
          </Button>
          <Button className="sm" title="Print-ready membership certificate" onClick={() => portalApi.certificate()}>
            Certificate
          </Button>
        </div>
      </section>

      <AlertBanners
        alerts={alerts}
        onAction={(target) => {
          if (target === 'support') navigate('/portal/support');
          else if (target === 'installments' || target === 'wallet') navigate(`/portal/payment`);
          else navigate('/portal/profile');
        }}
      />

      <div className="grid cols-2" style={{ marginBottom: 14, alignItems: 'start' }}>
        <PensionProgress summary={summary} overdue={summary.overdue_count > 0} />
        <div className="stack" style={{ gap: 14 }}>
          <WalletCard
            summary={wallet}
            title="My wallet"
            subtitle="Live ledger balance"
            actions={
              <>
                <Button className="sm light" onClick={() => navigate('/portal/payment')}>Payment &amp; wallet</Button>
              </>
            }
          />
          <Link
            to="/portal/donates"
            className="flex items-center gap-4 rounded-2xl bg-brand-gradient p-4 text-white shadow-soft-lg no-underline hover:no-underline"
          >
            <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-white/20 text-xl" aria-hidden="true">♡</span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold">Donate to a welfare fund</span>
              <span className="block text-sm text-sky-100">Pay securely through the gateway and get a receipt.</span>
            </span>
            <span className="text-lg" aria-hidden="true">→</span>
          </Link>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Kpi
          label="Due now"
          value={formatBDT(summary.due_now)}
          tone={summary.due_now > 0 ? 'danger' : 'ok'}
          hint={summary.overdue_count > 0 ? `${summary.overdue_count} overdue installment(s)` : 'Nothing overdue'}
        />
        <Kpi
          label="Next installment"
          value={summary.next_due ? formatBDT(summary.next_due.amount) : '—'}
          hint={summary.next_due ? `${formatDate(summary.next_due.due_date)} · ${dueLabel(summary.next_due.due_date)}` : 'All settled'}
        />
        <Kpi label="Total paid" value={formatBDT(summary.total_paid)} tone="ok" hint={`${summary.paid_installments} of ${summary.total_installments} installments`} />
        <Kpi label="Wallet balance" value={formatBDT(wallet?.balance ?? 0)} hint={`Available ${formatBDT(wallet?.available_balance ?? 0)}`} />
      </div>

      <Card
        title="Upcoming installments"
        actions={<Link className="btn sm ghost" to="/portal/payment">View all</Link>}
      >
        <Table
          rows={upcoming}
          empty="No upcoming installments - everything is settled. 🎉"
          columns={[
            { key: 'serial', header: 'Installment', render: (row) => `#${row.serial}${row.investment_title ? ` · ${row.investment_title}` : ''}` },
            { key: 'due_date', header: 'Due date', render: (row) => <>{formatDate(row.due_date)} <span className="small muted">({dueLabel(row.due_date)})</span></> },
            { key: 'outstanding', header: 'Amount due', align: 'right', render: (row) => formatBDT(row.outstanding) },
            { key: 'status', header: 'Status', render: (row) => <Badge status={profile.is_frozen && row.effective_status !== 'PAID' ? 'SUSPENDED' : row.effective_status} /> },
            {
              key: 'pay',
              header: '',
              align: 'right',
              render: (row) => (
                <Button className="sm primary" disabled={payingId === row.id || profile.is_frozen} onClick={() => payNow(row)}>
                  {payingId === row.id ? 'Opening…' : 'Pay now'}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <div className="grid cols-2" style={{ marginTop: 14, alignItems: 'start' }}>
        <Card title="Recent payments" actions={<Link className="btn sm ghost" to="/portal/payment">View all</Link>}>
          <Table
            rows={recent}
            empty="No payments yet."
            columns={[
              { key: 'paid_at', header: 'Date', render: (row) => (row.paid_at ? formatDateTime(row.paid_at) : formatDateTime(row.created_at)) },
              { key: 'installment_serial', header: 'Installment', render: (row) => `#${row.installment_serial}` },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              {
                key: 'receipt',
                header: '',
                align: 'right',
                render: (row) =>
                  row.status === 'SUCCESS' ? (
                    <Button className="sm ghost" onClick={() => portalApi.openReceipt(row.id)}>
                      Receipt
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
        <Card title="Profile completeness">
          <ProgressBar value={completion.percent} label={`${completion.done}/${completion.total} details`} size="lg" />
          {completion.missing.length ? (
            <>
              <p className="small muted" style={{ marginTop: 10 }}>
                Still missing: {completion.missing.map((m) => m.label).join(', ')}.
              </p>
              <Link className="btn sm primary" to="/portal/profile">Complete my profile</Link>
            </>
          ) : (
            <p className="small" style={{ marginTop: 10 }}>✓ Your profile is complete. Thank you!</p>
          )}
          <div className="stack small" style={{ marginTop: 12 }}>
            <div className="mono">{profile.mobile}</div>
            {profile.email ? <div className="muted">{profile.email}</div> : null}
          </div>
        </Card>
      </div>
    </>
  );
}
