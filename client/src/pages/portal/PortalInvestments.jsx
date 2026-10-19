import { Link } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { Alert, Badge, Card, Spinner } from '../../components/ui.jsx';
import { formatBDT, formatDate, dueLabel } from '../../utils/format.js';

export function PortalInvestments() {
  const { data, loading, error } = useApi(() => portalApi.investments(), []);
  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const investments = data.investments ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 14 }}>My investments</h1>
      {investments.length === 0 ? (
        <Card>
          <p className="muted">No investments yet.</p>
        </Card>
      ) : (
        <div className="grid cols-2">
          {investments.map((investment) => (
            <Card
              key={investment.id}
              title={investment.title || `Investment #${investment.id}`}
              actions={<Badge status={investment.status} />}
            >
              <div className="inline">
                <div className="progress" style={{ flex: 1, minWidth: 140 }}>
                  <span style={{ width: `${investment.progress_percent}%` }} />
                </div>
                <strong>{investment.progress_percent}%</strong>
              </div>
              <div className="summary-rows dark-text" style={{ marginTop: 12 }}>
                <div>
                  <span className="muted">Total</span>
                  <strong>{formatBDT(investment.total_amount)}</strong>
                </div>
                <div>
                  <span className="muted">Paid</span>
                  <strong>{formatBDT(investment.collected)}</strong>
                </div>
                <div>
                  <span className="muted">Remaining</span>
                  <strong>{formatBDT(investment.outstanding)}</strong>
                </div>
                <div>
                  <span className="muted">Progress</span>
                  <strong>
                    {investment.paid_installments}/{investment.installment_count} installments
                  </strong>
                </div>
                <div>
                  <span className="muted">Next due</span>
                  <strong>
                    {investment.next_due_date
                      ? `${formatDate(investment.next_due_date)} (${dueLabel(investment.next_due_date)})`
                      : '—'}
                  </strong>
                </div>
              </div>
              {investment.overdue_installments > 0 ? (
                <span className="badge danger" style={{ marginTop: 10 }}>
                  {investment.overdue_installments} overdue
                </span>
              ) : null}
              <div style={{ marginTop: 12 }}>
                <Link className="btn sm" to="/portal/installments">
                  View installments
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
