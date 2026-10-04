import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { investmentService } from '@/services/investment.service';
import { errorMessage } from '@/services/api';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/lib/format';
import { Alert, EmptyState, Loading, Money, Pagination, Select, StatusBadge } from '@/components/ui';

export default function InvestmentsList() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search);

  const params = useMemo(
    () => ({ search: debounced || undefined, status: status || undefined, page, pageSize: 20 }),
    [debounced, status, page],
  );
  const { data, isLoading, error } = useQuery({ queryKey: ['investments', params], queryFn: () => investmentService.list(params) });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Investments</h1>
          <p className="text-sm text-slate-500">Every investment with its collection progress.</p>
        </div>
        <Link to="/investments/new" className="btn-primary">
          + New investment
        </Link>
      </div>

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Search investor or investment id…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="w-44">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        </div>

        {isLoading ? (
          <Loading label="Loading investments…" />
        ) : error ? (
          <div className="p-4">
            <Alert kind="error">{errorMessage(error)}</Alert>
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState title="No investments found" description="Create an investment to generate its installment schedule." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">Investor</th>
                    <th className="th text-right">Total</th>
                    <th className="th text-right">Collected</th>
                    <th className="th text-right">Outstanding</th>
                    <th className="th">Progress</th>
                    <th className="th">Status</th>
                    <th className="th">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.items.map((investment) => (
                    <tr key={investment.id} className="hover:bg-slate-50">
                      <td className="td">
                        <Link to={`/investments/${investment.id}`} className="link font-medium">
                          {investment.investor?.name ?? investment.investorId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="td text-right"><Money poisha={investment.totalAmount} /></td>
                      <td className="td text-right"><Money poisha={investment.collected} /></td>
                      <td className="td text-right"><Money poisha={investment.outstanding} /></td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(investment.progress, 100)}%` }} />
                          </div>
                          <span className="text-xs text-slate-500">{investment.progress.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="td"><StatusBadge status={investment.status} /></td>
                      <td className="td">{formatDate(investment.createdAt)}</td>
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
