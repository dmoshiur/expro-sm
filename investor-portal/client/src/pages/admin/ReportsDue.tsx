import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { reportService } from '@/services/report.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/lib/format';
import { Alert, EmptyState, Loading, Money, Pagination, Select, StatCard, StatusBadge } from '@/components/ui';

interface DueRow {
  id: string;
  investmentId: string;
  serial: number;
  amount: string;
  paidAmount: string;
  outstanding: string;
  dueDate: string;
  status: string;
  daysOverdue: number;
  investor: { id: string; name: string; mobile: string };
}

export default function ReportsDue() {
  const { canExport } = useAuth();
  const [status, setStatus] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search);

  const params = useMemo(
    () => ({ status: status || undefined, overdueOnly: overdueOnly ? 'true' : undefined, page, pageSize: 25 }),
    [status, overdueOnly, page],
  );
  const { data, isLoading, error } = useQuery({ queryKey: ['report-due', params], queryFn: () => reportService.due(params) });

  const rows: DueRow[] = data?.items ?? [];
  const filtered = debounced
    ? rows.filter((row) => row.investor.name.toLowerCase().includes(debounced.toLowerCase()))
    : rows;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Due & overdue installments</h1>
          <p className="text-sm text-slate-500">Everything still payable across active investments.</p>
        </div>
        {canExport ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => reportService.download(`/reports/due.xlsx?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, 'due-overdue-installments.xlsx')}
          >
            Export Excel
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Contracted (filtered)" value={<Money poisha={data?.totals?.contracted ?? '0'} />} />
        <StatCard label="Paid" value={<Money poisha={data?.totals?.paid ?? '0'} />} tone="success" />
        <StatCard label="Outstanding" value={<Money poisha={data?.totals?.outstanding ?? '0'} />} tone="danger" />
      </div>

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Filter by investor name…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={overdueOnly} onChange={(event) => { setOverdueOnly(event.target.checked); setPage(1); }} /> Overdue only
            </label>
            <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="w-44">
              <option value="">All payable</option>
              <option value="PENDING">Pending</option>
              <option value="PARTIALLY_PAID">Partially paid</option>
              <option value="OVERDUE">Overdue</option>
            </Select>
          </div>
        </div>

        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="p-4"><Alert kind="error">{errorMessage(error)}</Alert></div>
        ) : filtered.length === 0 ? (
          <EmptyState title="Nothing pending" description="All installments in this filter are settled." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">Investor</th>
                    <th className="th">Installment</th>
                    <th className="th">Due date</th>
                    <th className="th text-right">Amount</th>
                    <th className="th text-right">Paid</th>
                    <th className="th text-right">Outstanding</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="td">
                        <Link to={`/investors/${row.investor.id}`} className="link">{row.investor.name}</Link>
                        <span className="ml-2 text-xs text-slate-400">{row.investor.mobile}</span>
                      </td>
                      <td className="td">
                        <Link to={`/investments/${row.investmentId}`} className="link">#{row.serial}</Link>
                      </td>
                      <td className="td">
                        {formatDate(row.dueDate)}
                        {row.daysOverdue > 0 ? <span className="ml-2 text-xs text-rose-600">{row.daysOverdue}d late</span> : null}
                      </td>
                      <td className="td text-right"><Money poisha={row.amount} /></td>
                      <td className="td text-right"><Money poisha={row.paidAmount} /></td>
                      <td className="td text-right font-medium"><Money poisha={row.outstanding} /></td>
                      <td className="td"><StatusBadge status={row.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data ? <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} /> : null}
          </>
        )}
      </div>
    </div>
  );
}
