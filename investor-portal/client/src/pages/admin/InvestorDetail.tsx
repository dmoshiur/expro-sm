import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { investorService, type NomineeInput } from '@/services/investor.service';
import { reportService } from '@/services/report.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import { formatDate, formatDateTime } from '@/lib/format';
import { Alert, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, Money, Spinner, StatusBadge } from '@/components/ui';
import type { Nominee } from '@/lib/types';

const schema = z.object({
  name: z.string().min(3).max(120),
  mobile: z
    .string()
    .trim()
    .regex(/^(01[3-9]\d{8}|\+?8801[3-9]\d{8})$/, 'Enter a valid Bangladeshi mobile'),
  address: z.string().max(300).optional().or(z.literal('')),
});

export default function InvestorDetail() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isSuperAdmin, canWrite } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [nomineesOpen, setNomineesOpen] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [nominees, setNominees] = useState<NomineeInput[]>([]);

  const { data, isLoading, error } = useQuery({ queryKey: ['investor', id], queryFn: () => investorService.get(id) });
  const investor = data?.investor;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['investor', id] });
    await queryClient.invalidateQueries({ queryKey: ['investors'] });
  };

  const updateMutation = useMutation({
    mutationFn: (values: z.infer<typeof schema>) => investorService.update(id, { name: values.name, mobile: values.mobile, address: values.address || null }),
    onSuccess: async () => {
      toast.success('Investor updated');
      setEditOpen(false);
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const statusMutation = useMutation({
    mutationFn: () => (investor?.status === 'ACTIVE' ? investorService.deactivate(id) : investorService.reactivate(id)),
    onSuccess: async () => {
      toast.success('Investor status updated');
      setConfirmStatus(false);
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const nomineesMutation = useMutation({
    mutationFn: () => investorService.setNominees(id, nominees),
    onSuccess: async () => {
      toast.success('Nominees updated');
      setNomineesOpen(false);
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const uploadMutation = useMutation({
    mutationFn: ({ kind, file }: { kind: 'photo' | 'nid'; file: File }) =>
      kind === 'photo' ? investorService.uploadPhoto(id, file) : investorService.uploadNidScan(id, file),
    onSuccess: async () => {
      toast.success('File uploaded');
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const openNidScan = async () => {
    try {
      const { url } = await investorService.nidScanUrl(id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (isLoading) return <Loading label="Loading investor…" />;
  if (error || !investor) return <Alert kind="error">{errorMessage(error)}</Alert>;

  const shareTotal = nominees.reduce((sum, nominee) => sum + Number(nominee.sharePercent || 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/investors" className="text-sm text-slate-500 hover:text-slate-700">
            ← Investors
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900">
            {investor.name} <StatusBadge status={investor.status} />
          </h1>
          <p className="text-sm text-slate-500">
            {investor.mobile} · created {formatDate(investor.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                reset({ name: investor.name, mobile: investor.mobile, address: investor.address ?? '' });
                setEditOpen(true);
              }}
            >
              Edit profile
            </button>
          ) : null}
          {isSuperAdmin ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setNominees(
                  (investor.nominees ?? []).map((nominee: Nominee) => ({
                    name: nominee.name,
                    relation: nominee.relation,
                    mobile: nominee.mobile,
                    sharePercent: nominee.sharePercent,
                  })),
                );
                setNomineesOpen(true);
              }}
            >
              Manage nominees ({investor.nomineeCount}/3)
            </button>
          ) : null}
          <button type="button" className="btn-secondary" onClick={() => reportService.download(`/reports/investors/${investor.id}/statement.xlsx`, `statement-${investor.id.slice(0, 8)}.xlsx`)}>
            Export statement
          </button>
          <button type="button" className="btn-secondary" onClick={() => reportService.download(`/reports/investors/${investor.id}/statement.pdf`, `statement-${investor.id.slice(0, 8)}.pdf`)}>
            PDF
          </button>
          {isSuperAdmin ? (
            <button type="button" className={investor.status === 'ACTIVE' ? 'btn-danger' : 'btn-primary'} onClick={() => setConfirmStatus(true)}>
              {investor.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Profile</h2>
          </div>
          <div className="card-body grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Mobile</p>
              <p className="text-sm text-slate-800">{investor.mobile}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">NID</p>
              <p className="text-sm text-slate-800">{investor.nid ?? (investor.hasNid ? 'Stored (masked for your role)' : 'Not provided')}</p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-slate-500">Address</p>
              <p className="text-sm text-slate-800">{investor.address || '—'}</p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-slate-500">Since</p>
              <p className="text-sm text-slate-800">
                {formatDate(investor.createdAt)} · {investor.investmentCount} investment(s) · {investor.nomineeCount} nominee(s)
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <p className="label">Photo</p>
              <div className="flex items-center gap-3">
                {investor.photoUrl ? (
                  <img src={investor.photoUrl} alt={investor.name} className="h-16 w-16 rounded-full object-cover" />
                ) : (
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-500">None</span>
                )}
                {canWrite ? (
                  <label className="btn-secondary cursor-pointer">
                    {uploadMutation.isPending ? <Spinner className="h-4 w-4" /> : null} Upload
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadMutation.mutate({ kind: 'photo', file });
                        event.target.value = '';
                      }}
                    />
                  </label>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-slate-500">JPG/PNG, max 2 MB.</p>
            </div>

            {isSuperAdmin ? (
              <div>
                <p className="label">NID scan (private)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-secondary" disabled={!investor.hasNidScan} onClick={openNidScan}>
                    View scan
                  </button>
                  <label className="btn-secondary cursor-pointer">
                    Upload
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadMutation.mutate({ kind: 'nid', file });
                        event.target.value = '';
                      }}
                    />
                  </label>
                </div>
                <p className="mt-1 text-xs text-slate-500">Stored privately and served through short-lived signed URLs.</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Nominees</h2>
          {!isSuperAdmin ? <span className="text-xs text-slate-500">Only super admins can edit nominees</span> : null}
        </div>
        {(investor.nominees ?? []).length === 0 ? (
          <EmptyState title="No nominees recorded" description="Add up to three nominees with shares totalling 100%." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Name</th>
                  <th className="th">Relation</th>
                  <th className="th">Mobile</th>
                  <th className="th text-right">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(investor.nominees ?? []).map((nominee: Nominee) => (
                  <tr key={nominee.id}>
                    <td className="td">{nominee.name}</td>
                    <td className="td">{nominee.relation}</td>
                    <td className="td">{nominee.mobile}</td>
                    <td className="td text-right">{nominee.sharePercent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Investments</h2>
          <Link to={`/investments/new?investorId=${investor.id}`} className="link text-sm">
            + New investment
          </Link>
        </div>
        {(investor.investments ?? []).length === 0 ? (
          <EmptyState title="No investments yet" description="Create the first investment and its installment schedule." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Total</th>
                  <th className="th">Installments</th>
                  <th className="th">Status</th>
                  <th className="th">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(investor.investments ?? []).map((investment) => (
                  <tr key={investment.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link to={`/investments/${investment.id}`} className="link">
                        <Money poisha={investment.totalAmount} />
                      </Link>
                    </td>
                    <td className="td">{investment.installmentCount}</td>
                    <td className="td">
                      <StatusBadge status={investment.status} />
                    </td>
                    <td className="td">{formatDate(investment.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(investor.smsLogs ?? []).length > 0 ? (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Recent SMS</h2>
          </div>
          <div className="card-body space-y-2">
            {(investor.smsLogs ?? []).map((log) => (
              <div key={log.id} className="rounded-lg border border-slate-100 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">
                    {log.purpose} · {log.toMobile}
                  </span>
                  <span className="text-xs text-slate-400">{formatDateTime(log.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{log.body}</p>
                <StatusBadge status={log.status} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <Modal
        open={editOpen}
        title="Edit investor"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="edit-investor" className="btn-primary" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Save changes
            </button>
          </>
        }
      >
        <form id="edit-investor" className="space-y-4" onSubmit={handleSubmit((values) => updateMutation.mutate(values))}>
          <Field label="Full name" error={errors.name?.message}>
            <Input {...register('name')} />
          </Field>
          <Field label="Mobile" error={errors.mobile?.message}>
            <Input {...register('mobile')} />
          </Field>
          <Field label="Address" error={errors.address?.message}>
            <Input {...register('address')} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={nomineesOpen}
        title="Nominees"
        onClose={() => setNomineesOpen(false)}
        wide
        footer={
          <>
            <span className={shareTotal === 100 ? 'mr-auto text-sm text-slate-500' : 'mr-auto text-sm text-rose-600'}>
              Total share: {shareTotal}% (must be 100%)
            </span>
            <button type="button" className="btn-secondary" onClick={() => setNomineesOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={nomineesMutation.isPending || shareTotal !== 100 || nominees.length === 0 || nominees.length > 3}
              onClick={() => nomineesMutation.mutate()}
            >
              Save nominees
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {nominees.map((nominee, index) => (
            <div key={index} className="grid gap-2 rounded-lg border border-slate-100 p-3 sm:grid-cols-4">
              <Input
                placeholder="Name"
                value={nominee.name}
                onChange={(event) => setNominees((rows) => rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))}
              />
              <Input
                placeholder="Relation"
                value={nominee.relation}
                onChange={(event) => setNominees((rows) => rows.map((row, i) => (i === index ? { ...row, relation: event.target.value } : row)))}
              />
              <Input
                placeholder="Mobile"
                value={nominee.mobile}
                onChange={(event) => setNominees((rows) => rows.map((row, i) => (i === index ? { ...row, mobile: event.target.value } : row)))}
              />
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={nominee.sharePercent}
                  onChange={(event) =>
                    setNominees((rows) => rows.map((row, i) => (i === index ? { ...row, sharePercent: Number(event.target.value) } : row)))
                  }
                />
                <button type="button" className="btn-ghost" onClick={() => setNominees((rows) => rows.filter((_, i) => i !== index))}>
                  ✕
                </button>
              </div>
            </div>
          ))}
          {nominees.length < 3 ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setNominees((rows) => [...rows, { name: '', relation: '', mobile: '', sharePercent: 0 }])}
            >
              + Add nominee
            </button>
          ) : (
            <p className="text-sm text-slate-500">Maximum of three nominees reached.</p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmStatus}
        title={investor.status === 'ACTIVE' ? 'Deactivate investor' : 'Reactivate investor'}
        message={
          investor.status === 'ACTIVE'
            ? 'Deactivating stops all payment links and reminders for this investor. Existing payments remain recorded.'
            : 'Reactivating lets this investor receive payment links and reminders again.'
        }
        confirmLabel={investor.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
        danger={investor.status === 'ACTIVE'}
        loading={statusMutation.isPending}
        onCancel={() => setConfirmStatus(false)}
        onConfirm={() => statusMutation.mutate()}
      />
    </div>
  );
}
