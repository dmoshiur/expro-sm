import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { auditService } from '@/services/report.service';
import { errorMessage } from '@/services/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, EmptyState, Loading, Modal, Pagination, Select } from '@/components/ui';
import type { AuditEntry } from '@/lib/types';

export default function AuditLog() {
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const params = useMemo(() => ({ action: action || undefined, entity: entity || undefined, page, pageSize: 25 }), [action, entity, page]);
  const { data, isLoading, error } = useQuery({ queryKey: ['audit', params], queryFn: () => auditService.list(params) });
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: auditService.actions });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Audit log</h1>
        <p className="text-sm text-slate-500">Append-only record of every administrative action. Rows can never be modified or deleted.</p>
      </div>

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <Select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} className="w-64">
            <option value="">All actions</option>
            {(actions.data ?? []).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </Select>
          <Select value={entity} onChange={(event) => { setEntity(event.target.value); setPage(1); }} className="w-44">
            <option value="">All entities</option>
            {['Admin', 'Investor', 'Nominee', 'Investment', 'Installment', 'Payment', 'Report', 'Setting', 'SmsLog'].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </Select>
        </div>

        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="p-4"><Alert kind="error">{errorMessage(error)}</Alert></div>
        ) : (data?.items ?? []).length === 0 ? (
          <EmptyState title="No audit entries match" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Actor</th>
                    <th className="th">Action</th>
                    <th className="th">Entity</th>
                    <th className="th">IP</th>
                    <th className="th"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.items.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="td">{formatDateTime(entry.createdAt)}</td>
                      <td className="td">{entry.admin?.name ?? 'System / job'}</td>
                      <td className="td font-mono text-xs">{entry.action}</td>
                      <td className="td">
                        {entry.entity}
                        {entry.entityId ? <span className="ml-1 text-xs text-slate-400">{entry.entityId.slice(0, 8)}</span> : null}
                      </td>
                      <td className="td text-xs text-slate-500">{entry.ip ?? '—'}</td>
                      <td className="td text-right">
                        <button type="button" className="btn-ghost text-xs" onClick={() => setSelected(entry)}>
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data ? <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} /> : null}
          </>
        )}
      </div>

      <Modal open={Boolean(selected)} title={selected ? titleCase(selected.action) : ''} onClose={() => setSelected(null)} wide>
        <div className="space-y-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <p><span className="text-slate-500">Actor:</span> {selected?.admin?.name ?? 'System / job'}</p>
            <p><span className="text-slate-500">When:</span> {formatDateTime(selected?.createdAt)}</p>
            <p><span className="text-slate-500">Entity:</span> {selected?.entity} {selected?.entityId}</p>
            <p><span className="text-slate-500">IP:</span> {selected?.ip ?? '—'}</p>
          </div>
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">Previous value</p>
            <pre className="max-h-56 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(selected?.oldValue ?? null, null, 2)}</pre>
          </div>
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">New value</p>
            <pre className="max-h-56 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(selected?.newValue ?? null, null, 2)}</pre>
          </div>
          <p className="text-xs text-slate-500">{selected?.userAgent}</p>
        </div>
      </Modal>
    </div>
  );
}
