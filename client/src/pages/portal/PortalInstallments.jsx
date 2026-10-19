import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Spinner, Table, Tabs } from '../../components/ui.jsx';
import { formatBDT, formatDate, dueLabel } from '../../utils/format.js';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'PENDING', label: 'Upcoming' },
  { key: 'PARTIALLY_PAID', label: 'Partially paid' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'PAID', label: 'Paid' },
];

export function PortalInstallments() {
  const navigate = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [payingId, setPayingId] = useState(null);
  const { data, loading, error } = useApi(() => portalApi.installments(status ? { status } : undefined), [status]);

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
      <h1 style={{ marginBottom: 14 }}>My installments</h1>
      <Tabs tabs={FILTERS} active={status} onChange={setStatus} />
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <Card>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table
            rows={data?.installments ?? []}
            empty="No installments in this list."
            columns={[
              { key: 'serial', header: 'Installment', render: (row) => `#${row.serial}${row.investment_title ? ` · ${row.investment_title}` : ` · Investment #${row.investment_id}`}` },
              {
                key: 'due_date',
                header: 'Due date',
                render: (row) => (
                  <>
                    {formatDate(row.due_date)}{' '}
                    {row.outstanding > 0 ? <span className="small muted">({dueLabel(row.due_date)})</span> : null}
                  </>
                ),
              },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              { key: 'amount_paid', header: 'Paid', align: 'right', render: (row) => formatBDT(row.amount_paid) },
              { key: 'outstanding', header: 'Due', align: 'right', render: (row) => formatBDT(row.outstanding) },
              { key: 'status', header: 'Status', render: (row) => <Badge status={row.effective_status} /> },
              {
                key: 'pay',
                header: '',
                align: 'right',
                render: (row) =>
                  row.outstanding > 0 && ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.effective_status) ? (
                    <Button className="sm primary" disabled={payingId === row.id} onClick={() => payNow(row)}>
                      {payingId === row.id ? 'Opening…' : 'Pay now'}
                    </Button>
                  ) : null,
              },
            ]}
          />
        )}
      </Card>
      <p className="muted small" style={{ marginTop: 10 }}>
        "Pay now" opens the secure bKash payment page for that installment - the same link you receive by SMS.
      </p>
    </>
  );
}
