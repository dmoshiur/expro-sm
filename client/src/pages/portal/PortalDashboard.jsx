import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Kpi, ProgressBar, Spinner, Table } from '../../components/ui.jsx';
import { WalletCard } from '../../components/WalletCard.jsx';
import { AlertBanners } from '../../components/AlertBanners.jsx';
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

  const progress = summary.total_installments
    ? Math.round((summary.paid_installments / summary.total_installments) * 100)
    : 0;

  return (
    <>
      <section className="profile-head">
        <div className="photo-frame">
          {profile.has_photo ? (
            <img src={`${portalApi.photoUrl}?v=${encodeURIComponent(profile.last_login_at ?? '')}`} alt="My photo" />
          ) : (
            <span className="avatar big" style={{ boxShadow: 'none' }}>
              {profile.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')}
            </span>
          )}
        </div>
        <div className="who-main">
          <h1>Assalamu alaikum, {profile.name.split(' ')[0]}</h1>
          <div className="who-meta">
            <span className="mono">{profile.member_code}</span> · Member since {formatDate(profile.member_since)} · Last
            login {profile.last_login_at ? formatDateTime(profile.last_login_at) : '—'}
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
          <Button className="sm" onClick={() => navigate('/portal/profile')}>My profile</Button>
          <Button className="sm ghost" title="Print-ready statement - use Print → Save as PDF" onClick={() => portalApi.statementPrint()}>
            PDF statement
          </Button>
          <Button className="sm ghost" title="Print-ready membership certificate" onClick={() => portalApi.certificate()}>
            Certificate
          </Button>
        </div>
      </section>

      <AlertBanners
        alerts={alerts}
        onAction={(target) => {
          if (target === 'support') navigate('/portal/support');
          else if (target === 'installments' || target === 'wallet') navigate(`/portal/profile?tab=${target}`);
          else navigate('/portal/profile');
        }}
      />

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <WalletCard
          summary={wallet}
          title="My wallet"
          subtitle="Live ledger balance"
          actions={
            <>
              <Button className="sm light" onClick={() => navigate('/portal/profile?tab=wallet')}>Open wallet</Button>
            </>
          }
        />
        <Card title="Pension progress">
          <ProgressBar
            value={progress}
            label={`${summary.paid_installments}/${summary.total_installments} installments`}
            size="lg"
            tone={summary.overdue_count ? 'warn' : ''}
          />
          <div className="stat-line"><span>Total invested</span><strong>{formatBDT(summary.total_invested)}</strong></div>
          <div className="stat-line"><span>Remaining</span><strong>{formatBDT(summary.total_remaining)}</strong></div>
          <div className="stat-line"><span>Overdue</span><strong>{formatBDT(summary.overdue_amount)}</strong></div>
          <div className="stat-line">
            <span>Plans</span>
            <strong>{summary.active_investments} active · {summary.completed_investments} completed</strong>
          </div>
          <Link className="btn sm ghost" to="/portal/profile?tab=installments" style={{ marginTop: 10 }}>View schedule →</Link>
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
        actions={<Link className="btn sm ghost" to="/portal/installments">View all</Link>}
      >
        <Table
          rows={upcoming}
          empty="No upcoming installments - everything is settled. 🎉"
          columns={[
            { key: 'serial', header: 'Installment', render: (row) => `#${row.serial}${row.investment_title ? ` · ${row.investment_title}` : ''}` },
            { key: 'due_date', header: 'Due date', render: (row) => <>{formatDate(row.due_date)} <span className="small muted">({dueLabel(row.due_date)})</span></> },
            { key: 'outstanding', header: 'Amount due', align: 'right', render: (row) => formatBDT(row.outstanding) },
            { key: 'status', header: 'Status', render: (row) => <Badge status={row.effective_status} /> },
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

      <Card title="Recent payments" actions={<Link className="btn sm ghost" to="/portal/payments">View all</Link>}>
        <Table
          rows={recent}
          empty="No payments yet."
          columns={[
            { key: 'paid_at', header: 'Date', render: (row) => (row.paid_at ? formatDateTime(row.paid_at) : formatDateTime(row.created_at)) },
            { key: 'installment_serial', header: 'Installment', render: (row) => `#${row.installment_serial}` },
            { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
            { key: 'method', header: 'Method' },
            { key: 'trx_id', header: 'Trx / Ref', mono: true, render: (row) => row.trx_id || row.manual_reference || '—' },
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
    </>
  );
}
