import { useState } from 'react';
import { reportsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Button, Card, Kpi, Select, Spinner, Table } from '../../components/ui.jsx';
import { BarChart, Donut } from '../../components/Charts.jsx';
import { formatBDT, formatNumber } from '../../utils/format.js';

export function ReportsCollections() {
  const toast = useToast();
  const [months, setMonths] = useState('12');
  const { data, loading, error } = useApi(() => reportsApi.collections({ months }), [months]);

  const download = async () => {
    try {
      await reportsApi.collectionsCsv({ months });
      toast.success('CSV downloaded');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const byMethod = data
    ? [
        { label: 'bKash', value: data.months.reduce((s, m) => s + Number(m.bkashAmount), 0) },
        { label: 'Cash', value: data.months.reduce((s, m) => s + Number(m.cashAmount), 0) },
        { label: 'Bank', value: data.months.reduce((s, m) => s + Number(m.bankAmount), 0) },
      ].filter((row) => row.value > 0)
    : [];

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Collections</h1>
        <div className="spacer" />
        <Select
          value={months}
          onChange={setMonths}
          options={[
            { value: '3', label: 'Last 3 months' },
            { value: '6', label: 'Last 6 months' },
            { value: '12', label: 'Last 12 months' },
            { value: '24', label: 'Last 24 months' },
          ]}
        />
        <Button className="sm" onClick={download}>⬇ CSV</Button>
      </div>

      <Alert tone="error">{error?.message}</Alert>
      {loading && !data ? (
        <Spinner />
      ) : (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Kpi label="Total collected" value={formatBDT(data?.total ?? 0, { compact: true })} />
            <Kpi label="Months covered" value={formatNumber(data?.months?.length ?? 0)} />
            <Kpi
              label="Average per month"
              value={formatBDT((data?.total ?? 0) / Math.max(1, data?.months?.length ?? 1), { compact: true })}
            />
          </div>

          <Card title="Collection by month">
            <BarChart data={data?.months ?? []} format={(value) => formatBDT(value, { compact: true })} />
          </Card>

          <div className="grid cols-2">
            <Card title="By payment method">
              <Donut
                data={byMethod.map((row) => ({ ...row, formatted: formatBDT(row.value, { compact: true }) }))}
              />
            </Card>
            <Card title="Monthly detail">
              <Table
                rows={data?.months ?? []}
                keyField="month"
                empty="No collections in this window."
                columns={[
                  { key: 'month', header: 'Month' },
                  { key: 'paymentCount', header: 'Payments', align: 'right' },
                  { key: 'amount', header: 'Collected', align: 'right', render: (row) => formatBDT(row.amount) },
                  { key: 'bkashAmount', header: 'bKash', align: 'right', render: (row) => formatBDT(row.bkashAmount) },
                  { key: 'cashAmount', header: 'Cash', align: 'right', render: (row) => formatBDT(row.cashAmount) },
                  { key: 'bankAmount', header: 'Bank', align: 'right', render: (row) => formatBDT(row.bankAmount) },
                ]}
                footer={
                  data
                    ? [
                        <td key="l">Total</td>,
                        <td key="c" className="num" />,
                        <td key="a" className="num">{formatBDT(data.total)}</td>,
                        <td key="b" className="num" colSpan={3} />,
                      ]
                    : null
                }
              />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
