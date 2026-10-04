import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { investmentService } from '@/services/investment.service';
import { paymentService } from '@/services/payment.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import { bdt, formatDate, formatDateTime } from '@/lib/format';
import { Alert, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, Money, Select, Spinner, StatusBadge } from '@/components/ui';
import type { Installment } from '@/lib/types';

export default function InvestmentDetail() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canWrite, isSuperAdmin } = useAuth();
  const [manualFor, setManualFor] = useState<Installment | null>(null);
  const [reasonFor, setReasonFor] = useState<{ installment: Installment; action: 'waive' | 'cancel' | 'reopen' } | null>(null);
  const [reason, setReason] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [manualMethod, setManualMethod] = useState<'CASH' | 'BANK' | 'OTHER'>('CASH');
  const [manualReference, setManualReference] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);

  const { data: investment, isLoading, error } = useQuery({ queryKey: ['investment', id], queryFn: () => investmentService.get(id) });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['investment', id] });
    await queryClient.invalidateQueries({ queryKey: ['investments'] });
  };

  const manualMutation = useMutation({
    mutationFn: () =>
      paymentService.recordManual(manualFor!.id, {
        amount: manualAmount || undefined,
        method: manualMethod,
        reference: manualReference,
        note: manualNote || undefined,
      }),
    onSuccess: async (result) => {
      toast.success(`Payment recorded · receipt ${result.receiptNumber}`);
      setManualFor(null);
      setManualAmount('');
      setManualReference('');
      setManualNote('');
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const linkMutation = useMutation({
    mutationFn: async ({ installmentId, send }: { installmentId: string; send: boolean }): Promise<{ url?: string; sms?: { success: boolean; error?: string } }> =>
      send
        ? ((await paymentService.sendLink(installmentId)) as { url?: string; sms?: { success: boolean; error?: string } })
        : await paymentService.regenerateLink(installmentId, false),
    onSuccess: async (result, variables) => {
      if (result.url) {
        setGeneratedLink(result.url);
        await navigator.clipboard.writeText(result.url).catch(() => undefined);
      }
      if (variables.send) {
        if (result.sms && !result.sms.success) {
          toast.error(`SMS failed (${result.sms.error ?? 'provider error'}) — the link is copied, share it manually`);
        } else {
          toast.success('Payment link sent by SMS and copied to the clipboard');
        }
      } else if (result.url) {
        toast.success('New link generated and copied to the clipboard');
      }
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const bulkMutation = useMutation({
    mutationFn: () => paymentService.sendLinksForInvestment(id),
    onSuccess: async (result) => {
      toast.success(`Sent ${result.sent} link(s), ${result.failed} failed, ${result.skipped} skipped`);
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const reasonMutation = useMutation({
    mutationFn: () => {
      const target = reasonFor!;
      if (target.action === 'waive') return investmentService.waive(target.installment.id, reason);
      if (target.action === 'cancel') return investmentService.cancelInstallment(target.installment.id, reason);
      return investmentService.reopen(target.installment.id, reason);
    },
    onSuccess: async () => {
      toast.success('Installment updated');
      setReasonFor(null);
      setReason('');
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const cancelInvestmentMutation = useMutation({
    mutationFn: () => investmentService.cancel(id, reason),
    onSuccess: async () => {
      toast.success('Investment cancelled');
      setReason('');
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <Loading label="Loading investment…" />;
  if (error || !investment) return <Alert kind="error">{errorMessage(error)}</Alert>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/investments" className="text-sm text-slate-500 hover:text-slate-700">
            ← Investments
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900">
            Investment {investment.id.slice(0, 8)} <StatusBadge status={investment.status} />
          </h1>
          <p className="text-sm text-slate-500">
            {investment.investor ? (
              <Link to={`/investors/${investment.investor.id}`} className="link">
                {investment.investor.name}
              </Link>
            ) : null}{' '}
            · created {formatDate(investment.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => bulkMutation.mutate()} disabled={bulkMutation.isPending || !canWrite}>
            {bulkMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
            Send all payment links
          </button>
          {isSuperAdmin && investment.status !== 'CANCELLED' ? (
            <button type="button" className="btn-danger" onClick={() => setReasonFor({ installment: investment.installments[0]!, action: 'reopen' })} disabled>
              Cancel investment
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-body">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total</p>
          <p className="text-xl font-semibold"><Money poisha={investment.totalAmount} /></p>
        </div>
        <div className="card card-body">
          <p className="text-xs uppercase tracking-wide text-slate-500">Collected</p>
          <p className="text-xl font-semibold text-emerald-600"><Money poisha={investment.collected} /></p>
        </div>
        <div className="card card-body">
          <p className="text-xs uppercase tracking-wide text-slate-500">Outstanding</p>
          <p className="text-xl font-semibold text-brand-700"><Money poisha={investment.outstanding} /></p>
        </div>
        <div className="card card-body">
          <p className="text-xs uppercase tracking-wide text-slate-500">Installments</p>
          <p className="text-xl font-semibold">
            {investment.paidCount}/{investment.installmentCount} paid
          </p>
        </div>
      </div>

      {generatedLink ? (
        <Alert kind="success">
          Payment link (also copied):{' '}
          <span className="break-all font-mono text-xs">{generatedLink}</span>
        </Alert>
      ) : null}

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Installments</h2>
          <span className="text-xs text-slate-500">Amounts are stored in poisha and never use floating point</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">#</th>
                <th className="th">Due date</th>
                <th className="th text-right">Amount</th>
                <th className="th text-right">Paid</th>
                <th className="th text-right">Outstanding</th>
                <th className="th">Status</th>
                <th className="th">Link</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {investment.installments.map((installment) => {
                const payable = ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(installment.status);
                return (
                  <tr key={installment.id} className="hover:bg-slate-50">
                    <td className="td">{installment.serial}</td>
                    <td className="td">
                      {formatDate(installment.dueDate)}
                      {installment.isOverdue && installment.status !== 'PAID' ? (
                        <span className="ml-2 text-xs text-rose-600">{installment.daysOverdue ?? 0}d overdue</span>
                      ) : null}
                    </td>
                    <td className="td text-right"><Money poisha={installment.amount} /></td>
                    <td className="td text-right"><Money poisha={installment.paidAmount} /></td>
                    <td className="td text-right"><Money poisha={installment.outstanding} /></td>
                    <td className="td">
                      <StatusBadge status={installment.status} />
                      {installment.lastRemindedAt ? (
                        <span className="ml-2 text-xs text-slate-400">reminded {formatDate(installment.lastRemindedAt)}</span>
                      ) : null}
                    </td>
                    <td className="td text-xs text-slate-500">
                      {installment.hasActiveLink ? `expires ${formatDate(installment.linkExpiresAt)}` : '—'}
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap justify-end gap-1">
                        {payable && canWrite ? (
                          <>
                            <button type="button" className="btn-ghost text-xs" onClick={() => setManualFor(installment)}>
                              Record payment
                            </button>
                            <button
                              type="button"
                              className="btn-ghost text-xs"
                              onClick={() => linkMutation.mutate({ installmentId: installment.id, send: true })}
                            >
                              Send link
                            </button>
                            <button
                              type="button"
                              className="btn-ghost text-xs"
                              onClick={() => linkMutation.mutate({ installmentId: installment.id, send: false })}
                            >
                              New link
                            </button>
                          </>
                        ) : null}
                        {canWrite && payable ? (
                          <button type="button" className="btn-ghost text-xs text-amber-700" onClick={() => { setReasonFor({ installment, action: 'waive' }); setReason(''); }}>
                            Waive
                          </button>
                        ) : null}
                        {canWrite && payable && isSuperAdmin ? (
                          <button type="button" className="btn-ghost text-xs text-rose-700" onClick={() => { setReasonFor({ installment, action: 'cancel' }); setReason(''); }}>
                            Cancel
                          </button>
                        ) : null}
                        {isSuperAdmin && ['WAIVED', 'CANCELLED'].includes(installment.status) ? (
                          <button type="button" className="btn-ghost text-xs" onClick={() => { setReasonFor({ installment, action: 'reopen' }); setReason(''); }}>
                            Reopen
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {investment.notes ? <p className="border-t border-slate-100 px-4 py-3 text-sm text-slate-600">Note: {investment.notes}</p> : null}
      </div>

      <Modal
        open={Boolean(manualFor)}
        title={`Record manual payment · installment ${manualFor?.serial ?? ''}`}
        onClose={() => setManualFor(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setManualFor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={manualMutation.isPending || manualReference.trim().length < 3}
              onClick={() => manualMutation.mutate()}
            >
              {manualMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Record payment
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Alert kind="info">
            Outstanding: <strong>{bdt(manualFor?.outstanding ?? '0')}</strong>. Leave the amount empty to settle the full outstanding balance.
          </Alert>
          <Field label="Amount (BDT)">
            <Input inputMode="decimal" placeholder={manualFor ? String(Number(manualFor.outstanding) / 100) : ''} value={manualAmount} onChange={(event) => setManualAmount(event.target.value)} />
          </Field>
          <Field label="Method">
            <Select value={manualMethod} onChange={(event) => setManualMethod(event.target.value as 'CASH' | 'BANK' | 'OTHER')}>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank transfer</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field label="Reference" hint="Receipt number, bank slip or deposit reference (required)">
            <Input value={manualReference} onChange={(event) => setManualReference(event.target.value)} placeholder="BANK-SLIP-12345" />
          </Field>
          <Field label="Note (optional)">
            <Input value={manualNote} onChange={(event) => setManualNote(event.target.value)} placeholder="Received at the office…" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={Boolean(reasonFor)}
        title={reasonFor?.action === 'waive' ? 'Waive installment' : reasonFor?.action === 'cancel' ? 'Cancel installment' : 'Reopen installment'}
        onClose={() => setReasonFor(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setReasonFor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={reasonFor?.action === 'waive' ? 'btn-primary' : 'btn-primary'}
              disabled={reason.trim().length < 3 || reasonMutation.isPending}
              onClick={() => reasonMutation.mutate()}
            >
              {reasonMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Confirm
            </button>
          </>
        }
      >
        <Field label="Reason" hint="Stored in the audit trail (immutable history)">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. investor settled early / dispute" />
        </Field>
      </Modal>

      <ConfirmDialog
        open={false}
        title=""
        message=""
        onCancel={() => setReasonFor(null)}
        onConfirm={() => cancelInvestmentMutation.mutate()}
      />

      {investment.installments.length === 0 ? <EmptyState title="No installments" /> : null}
      {investment.updatedAt ? (
        <p className="text-xs text-slate-400">Last updated {formatDateTime(investment.updatedAt)}</p>
      ) : null}
    </div>
  );
}
