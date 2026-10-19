import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Kpi, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDate, formatDateTime, dueLabel } from '../../utils/format.js';

export function PortalDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, error } = useApi(() => portalApi.dashboard(), []);
  const [payingId, setPayingId] = useState(null);

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const { profile, completion, summary, upcoming_installments: upcoming, recent_payments: recent } = data;

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

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        {profile.has_photo ? (
          <img
            src={portalApi.photoUrl}
            alt="My photo"
            style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: '50%', border: '1px solid var(--border)' }}
          />
        ) : (
          <div className="avatar big" aria-hidden="true">
            {profile.name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')}
          </div>
        )}
        <div>
          <h1 style={{ margin: 0 }}>{profile.name}</h1>
          <div className="small muted">
            <span className="mono">{profile.member_code}</span> · Member since {formatDate(profile.member_since)} · Last
            login {profile.last_login_at ? formatDateTime(profile.last_login_at) : '—'}
          </div>
        </div>
        <Badge status={profile.status} />
        <div className="spacer" />
        <Button className="sm" onClick={() => navigate('/portal/profile')}>
          My profile
        </Button>
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
        <Kpi label="Remaining" value={formatBDT(summary.total_remaining)} hint={`${formatBDT(summary.total_invested)} invested in total`} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <section className="card summary-card">
          <header>
            <h2>💼 Account summary</h2>
          </header>
          <div className="muted-on-dark">Paid so far</div>
          <div className="summary-big">{formatBDT(summary.total_paid)}</div>
          <div className="summary-rows">
            <div>
              <span>Total invested</span>
              <strong>{formatBDT(summary.total_invested)}</strong>
            </div>
            <div>
              <span>Remaining</span>
              <strong>{formatBDT(summary.total_remaining)}</strong>
            </div>
            <div>
              <span>Overdue</span>
              <strong>{formatBDT(summary.overdue_amount)}</strong>
            </div>
            <div>
              <span>Installments paid</span>
              <strong>
                {summary.paid_installments}/{summary.total_installments}
              </strong>
            </div>
          </div>
        </section>

        <Card title="Profile completeness">
          <div className="inline">
            <div className="progress" style={{ flex: 1, minWidth: 160 }}>
              <span style={{ width: `${completion.percent}%` }} />
            </div>
            <strong>{completion.percent}%</strong>
          </div>
          {completion.missing.length ? (
            <>
              <p className="small muted" style={{ marginTop: 10 }}>
                Still missing: {completion.missing.map((m) => m.label).join(', ')}.
              </p>
              <Link className="btn sm primary" to="/portal/profile">
                Complete my profile
              </Link>
            </>
          ) : (
            <p className="small" style={{ marginTop: 10 }}>✓ Your profile is complete. Thank you!</p>
          )}
          <div className="stack small" style={{ marginTop: 14 }}>
            <div>
              <span className="muted">Active investments:</span> {summary.active_investments} ·{' '}
              <span className="muted">Completed:</span> {summary.completed_investments}
            </div>
            <div>
              <span className="muted">Mobile:</span> <span className="mono">{profile.mobile}</span>
              {profile.email ? (
                <>
                  {' '}· <span className="muted">Email:</span> {profile.email}
                </>
              ) : null}
            </div>
          </div>
        </Card>
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
                <Button className="sm primary" disabled={payingId === row.id} onClick={() => payNow(row)}>
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
