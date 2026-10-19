import { portalApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Spinner, Table } from '../../components/ui.jsx';
import { formatBDT, formatDateTime } from '../../utils/format.js';

export function PortalPayments() {
  const toast = useToast();
  const { data, loading, error } = useApi(() => portalApi.payments(), []);

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>My payments</h1>
        <div className="spacer" />
        <Button
          className="sm"
          onClick={async () => {
            try {
              await portalApi.statementCsv();
              toast.success('Statement downloaded');
            } catch (err) {
              toast.error(err.message);
            }
          }}
        >
          ⬇ Download statement (CSV)
        </Button>
      </div>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <Card>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table
            rows={data?.payments ?? []}
            empty="No payments yet."
            columns={[
              { key: 'paid_at', header: 'Date', render: (row) => formatDateTime(row.paid_at ?? row.created_at) },
              { key: 'installment_serial', header: 'Installment', render: (row) => `#${row.installment_serial}${row.investment_title ? ` · ${row.investment_title}` : ''}` },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatBDT(row.amount) },
              { key: 'method', header: 'Method' },
              { key: 'trx_id', header: 'Trx / Ref', mono: true, render: (row) => row.trx_id || row.manual_reference || '—' },
              { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
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
        )}
      </Card>
    </>
  );
}
