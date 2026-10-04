import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { paymentService } from '@/services/payment.service';
import { errorMessage } from '@/services/api';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, EmptyState, Loading, Money, Modal, Pagination, Select, StatusBadge } from '@/components/ui';
import type { Payment } from '@/lib/types';

export default function PaymentsList() {
  const [tab, setTab] = useState<'payments' | 'sms'>('payments');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<Payment | null>(null);
  const debounced = useDebounce(search);

  const params = useMemo(
    () => ({ search: debounced || undefined, status: status || undefined, method: method || undefined, page, pageSize: 25 }),
    [debounced, status, method, page],
  );

  const payments = useQuery({ queryKey: ['payments', params], queryFn: () => paymentService.list(params), enabled: tab === 'payments' });
  const smsLogs = useQuery({ queryKey: ['sms-logs', page], queryFn: () => paymentService.smsLogs({ page, pageSize: 25 }), enabled: tab === 'sms' });

  const active = tab === 'payments' ? payments : smsLogs;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Payments</h1>
        <p className="text-sm text-slate-500">bKash settlements, manual entries and the SMS delivery log.</p>
      </div>

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              className={tab === 'payments' ? 'btn bg-white text-slate-900 shadow-sm' : 'btn text-slate-600'}
              onClick={() => { setTab('payments'); setPage(1); }}
            >
              Payments
            </button>
            <button
              type="button"
              className={tab === 'sms' ? 'btn bg-white text-slate-900 shadow-sm' : 'btn text-slate-600'}
              onClick={() => { setTab('sms'); setPage(1); }}
            >
              SMS log
            </button>
          </div>
          {tab === 'payments' ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input max-w-xs"
                placeholder="Search trx id, receipt, investor…"
                value={search}
                onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              />
              <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="w-40">
                <option value="">All statuses</option>
                {['SUCCESS', 'PENDING', 'INITIATED', 'FAILED', 'CANCELLED'].map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </Select>
              <Select value={method} onChange={(event) => { setMethod(event.target.value); setPage(1); }} className="w-36">
                <option value="">All methods</option>
                {['BKASH', 'CASH', 'BANK', 'OTHER'].map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>

        {active.isLoading ? (
          <Loading />
        ) : active.error ? (
          <div className="p-4"><Alert kind="error">{errorMessage(active.error)}</Alert></div>
        ) : tab === 'payments' ? (
          (payments.data?.items ?? []).length === 0 ? (
            <EmptyState title="No payments match the filters" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="th">Investor</th>
                      <th className="th">Installment</th>
                      <th className="th">Method</th>
                      <th className="th">Reference</th>
                      <th className="th text-right">Amount</th>
                      <th className="th">Status</th>
                      <th className="th">When</th>
                      <th className="th"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {payments.data?.items.map((payment) => (
                      <tr key={payment.id} className="hover:bg-slate-50">
                        <td className="td">
                          {payment.installment?.investment?.investor ? (
                            <Link to={`/investors/${payment.installment.investment.investor.id}`} className="link">
                              {payment.installment.investment.investor.name}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td">{payment.installment ? `${payment.installment.serial}` : '—'}</td>
                        <td className="td">{payment.method}</td>
                        <td className="td text-xs text-slate-500">{payment.receiptNumber ?? payment.trxId ?? payment.manualReference ?? '—'}</td>
                        <td className="td text-right"><Money poisha={payment.amount} /></td>
                        <td className="td"><StatusBadge status={payment.status} /></td>
                        <td className="td">{formatDateTime(payment.completedAt ?? payment.createdAt)}</td>
                        <td className="td text-right">
                          <button type="button" className="btn-ghost text-xs" onClick={() => setDetail(payment)}>
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {payments.data ? <Pagination page={payments.data.page} totalPages={payments.data.totalPages} total={payments.data.total} onChange={setPage} /> : null}
            </>
          )
        ) : (smsLogs.data?.items ?? []).length === 0 ? (
          <EmptyState title="No SMS sent yet" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">To</th>
                    <th className="th">Purpose</th>
                    <th className="th">Message</th>
                    <th className="th">Provider</th>
                    <th className="th">Status</th>
                    <th className="th">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {smsLogs.data?.items.map((log) => (
                    <tr key={log.id}>
                      <td className="td">{log.toMobile}</td>
                      <td className="td">{titleCase(log.purpose)}</td>
                      <td className="td max-w-md truncate text-xs text-slate-600" title={log.body}>{log.body}</td>
                      <td className="td">{log.provider}</td>
                      <td className="td"><StatusBadge status={log.status} /></td>
                      <td className="td">{formatDateTime(log.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {smsLogs.data ? <Pagination page={smsLogs.data.page} totalPages={smsLogs.data.totalPages} total={smsLogs.data.total} onChange={setPage} /> : null}
          </>
        )}
      </div>

      <Modal
        open={Boolean(detail)}
        title="Payment detail"
        onClose={() => setDetail(null)}
        footer={
          <>
            {detail?.status === 'SUCCESS' ? (
              <a className="btn-secondary" href={paymentService.receiptUrl(detail.id)} target="_blank" rel="noreferrer">
                Download receipt (PDF)
              </a>
            ) : null}
            <button type="button" className="btn-primary" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {detail ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {[
              ['Amount', <Money key="amount" poisha={detail.amount} />],
              ['Status', <StatusBadge key="status" status={detail.status} />],
              ['Method', detail.method],
              ['Gateway', detail.gateway],
              ['Receipt', detail.receiptNumber ?? '—'],
              ['Transaction ID', detail.trxId ?? '—'],
              ['Gateway payment id', detail.gatewayPaymentId ?? '—'],
              ['Manual reference', detail.manualReference ?? '—'],
              ['Recorded by', detail.recordedByAdmin?.name ?? 'Online'],
              ['Completed', formatDateTime(detail.completedAt)],
              ['Failure reason', detail.failureReason ?? '—'],
            ].map(([label, value], index) => (
              <div key={index}>
                <dt className="text-xs uppercase tracking-wide text-slate-500">{label as string}</dt>
                <dd className="text-sm text-slate-800">{value as React.ReactNode}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Modal>
    </div>
  );
}
