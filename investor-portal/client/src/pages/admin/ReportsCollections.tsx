import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { reportService } from '@/services/report.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { bdt, formatDateTime } from '@/lib/format';
import { Alert, EmptyState, Loading, Money, Pagination, Select, StatCard, StatusBadge } from '@/components/ui';

export default function ReportsCollections() {
  const { canExport } = useAuth();
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const params = useMemo(
    () => ({ method: method || undefined, from: from || undefined, to: to || undefined, page, pageSize: 25 }),
    [method, from, to, page],
  );
  const { data, isLoading, error } = useQuery({ queryKey: ['report-collections', params], queryFn: () => reportService.collections(params) });

  const exportUrl = `/reports/collections.xlsx?${new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]),
  )}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Collection register</h1>
          <p className="text-sm text-slate-500">Every successful bKash settlement and manual payment.</p>
        </div>
        {canExport ? (
          <button type="button" className="btn-secondary" onClick={() => reportService.download(exportUrl, 'collection-register.xlsx')}>
            Export Excel
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total collected (filtered)" value={<Money poisha={data?.totals?.amount ?? '0'} />} tone="success" />
        <StatCard label="Payments" value={data?.totals?.count ?? 0} />
        <div className="card card-body">
          <p className="text-xs uppercase tracking-wide text-slate-500">By method</p>
          <ul className="mt-1 space-y-1 text-sm text-slate-700">
            {(data?.totals?.byMethod ?? []).map((row) => (
              <li key={row.method} className="flex justify-between">
                <span>{row.method}</span>
                <span className="tabular-nums">
                  {bdt(row.amount)} · {row.count}
                </span>
              </li>
            ))}
            {(data?.totals?.byMethod ?? []).length === 0 ? <li className="text-slate-400">No payments in range</li> : null}
          </ul>
        </div>
      </div>

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" className="input w-40" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} />
            <span className="text-sm text-slate-500">to</span>
            <input type="date" className="input w-40" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} />
            <Select value={method} onChange={(event) => { setMethod(event.target.value); setPage(1); }} className="w-36">
              <option value="">All methods</option>
              <option value="BKASH">bKash</option>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank</option>
              <option value="OTHER">Other</option>
            </Select>
          </div>
        </div>

        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="p-4"><Alert kind="error">{errorMessage(error)}</Alert></div>
        ) : (data?.items ?? []).length === 0 ? (
          <EmptyState title="No collections in this range" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">Collected at</th>
                    <th className="th">Investor</th>
                    <th className="th">Installment</th>
                    <th className="th">Method</th>
                    <th className="th">Reference</th>
                    <th className="th text-right">Amount</th>
                    <th className="th">Recorded by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.items.map((payment) => (
                    <tr key={payment.id} className="hover:bg-slate-50">
                      <td className="td">{formatDateTime(payment.completedAt)}</td>
                      <td className="td">
                        <Link to={`/investors/${payment.installment?.investment?.investor.id}`} className="link">
                          {payment.installment?.investment?.investor.name}
                        </Link>
                      </td>
                      <td className="td">#{payment.installment?.serial}</td>
                      <td className="td">{payment.method}</td>
                      <td className="td text-xs text-slate-500">{payment.receiptNumber ?? payment.trxId ?? payment.manualReference ?? '—'}</td>
                      <td className="td text-right"><Money poisha={payment.amount} /></td>
                      <td className="td">{payment.recordedByAdmin?.name ?? 'Online'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data ? <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} /> : null}
            <div className="border-t border-slate-100 px-4 py-3">
              <StatusBadge status="SUCCESS" />
              <span className="ml-2 text-xs text-slate-500">Only successful payments are included in this register.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
