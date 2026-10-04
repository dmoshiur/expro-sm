import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { adminService } from '@/services/auth.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import { formatDateTime } from '@/lib/format';
import { Alert, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, Select, Spinner, StatusBadge, Pagination } from '@/components/ui';
import type { Admin } from '@/lib/types';

const passwordRule = z
  .string()
  .min(10, 'At least 10 characters')
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/[0-9]/, 'Must contain a number');

const createSchema = z.object({
  name: z.string().min(3, 'Name is required').max(120),
  email: z.string().email('Enter a valid email'),
  password: passwordRule,
  role: z.enum(['SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER']),
});
type CreateValues = z.infer<typeof createSchema>;

export default function Admins() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { admin: me } = useAuth();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [resetting, setResetting] = useState<Admin | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState<{ admin: Admin; action: 'toggle' } | null>(null);

  const params = { role: role || undefined, page, pageSize: 20 };
  const { data, isLoading, error } = useQuery({ queryKey: ['admins', params], queryFn: () => adminService.list(params) });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admins'] });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateValues>({ resolver: zodResolver(createSchema), defaultValues: { role: 'VIEWER' } });

  const createMutation = useMutation({
    mutationFn: (values: CreateValues) => adminService.create(values),
    onSuccess: async () => {
      toast.success('Admin created');
      setCreateOpen(false);
      reset();
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: (target: Admin) => adminService.update(target.id, { isActive: !target.isActive }),
    onSuccess: async () => {
      toast.success('Admin updated');
      setConfirm(null);
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: () => adminService.resetPassword(resetting!.id, newPassword),
    onSuccess: async () => {
      toast.success('Password reset. Share it with the admin over a secure channel.');
      setResetting(null);
      setNewPassword('');
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const reset2faMutation = useMutation({
    mutationFn: (target: Admin) => adminService.resetTwoFactor(target.id),
    onSuccess: async () => {
      toast.success('2FA reset — the admin must set it up again at next sign in');
      await invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Admins</h1>
          <p className="text-sm text-slate-500">Only super admins can manage accounts, roles and 2FA.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
          + New admin
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <Select value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }} className="w-44">
            <option value="">All roles</option>
            <option value="SUPER_ADMIN">Super admin</option>
            <option value="ACCOUNTANT">Accountant</option>
            <option value="VIEWER">Viewer</option>
          </Select>
        </div>

        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="p-4"><Alert kind="error">{errorMessage(error)}</Alert></div>
        ) : (data?.items ?? []).length === 0 ? (
          <EmptyState title="No admins found" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Email</th>
                    <th className="th">Role</th>
                    <th className="th">2FA</th>
                    <th className="th">Status</th>
                    <th className="th">Last login</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.items.map((admin) => (
                    <tr key={admin.id} className="hover:bg-slate-50">
                      <td className="td">{admin.name}{admin.id === me?.id ? <span className="ml-2 text-xs text-brand-600">(you)</span> : null}</td>
                      <td className="td">{admin.email}</td>
                      <td className="td">{admin.role.replace('_', ' ')}</td>
                      <td className="td">{admin.twoFAEnabled ? <StatusBadge status="SUCCESS" /> : <span className="badge bg-amber-50 text-amber-700">Not set</span>}</td>
                      <td className="td"><StatusBadge status={admin.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                      <td className="td">{admin.lastLoginAt ? formatDateTime(admin.lastLoginAt) : '—'}</td>
                      <td className="td">
                        <div className="flex flex-wrap justify-end gap-1">
                          <button type="button" className="btn-ghost text-xs" onClick={() => { setResetting(admin); setNewPassword(''); }}>
                            Reset password
                          </button>
                          <button type="button" className="btn-ghost text-xs" onClick={() => reset2faMutation.mutate(admin)}>
                            Reset 2FA
                          </button>
                          <button type="button" className="btn-ghost text-xs" onClick={() => adminService.unlock(admin.id).then(() => toast.success('Account unlocked'), (err) => toast.error(errorMessage(err)))}>
                            Unlock
                          </button>
                          {admin.id !== me?.id ? (
                            <button
                              type="button"
                              className={admin.isActive ? 'btn-ghost text-xs text-rose-700' : 'btn-ghost text-xs text-emerald-700'}
                              onClick={() => setConfirm({ admin, action: 'toggle' })}
                            >
                              {admin.isActive ? 'Disable' : 'Enable'}
                            </button>
                          ) : null}
                        </div>
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

      <Modal
        open={createOpen}
        title="New admin"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button type="submit" form="admin-form" className="btn-primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Create admin
            </button>
          </>
        }
      >
        <form id="admin-form" className="space-y-4" onSubmit={handleSubmit((values) => createMutation.mutate(values))}>
          <Field label="Full name" error={errors.name?.message}>
            <Input {...register('name')} />
          </Field>
          <Field label="Email" error={errors.email?.message}>
            <Input type="email" {...register('email')} />
          </Field>
          <Field label="Temporary password" error={errors.password?.message} hint="At least 10 characters with a letter and a number">
            <Input type="text" {...register('password')} />
          </Field>
          <Field label="Role" error={errors.role?.message}>
            <Select {...register('role')}>
              <option value="VIEWER">Viewer — read only</option>
              <option value="ACCOUNTANT">Accountant — payments & reports</option>
              <option value="SUPER_ADMIN">Super admin — everything</option>
            </Select>
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(resetting)}
        title={`Reset password · ${resetting?.name ?? ''}`}
        onClose={() => setResetting(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setResetting(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={resetPasswordMutation.isPending || newPassword.length < 10} onClick={() => resetPasswordMutation.mutate()}>
              {resetPasswordMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Reset password
            </button>
          </>
        }
      >
        <Field label="New temporary password" hint="The admin should change it immediately after signing in.">
          <Input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.admin.isActive ? 'Disable admin' : 'Enable admin'}
        message={confirm?.admin.isActive ? `${confirm?.admin.name} will no longer be able to sign in.` : `${confirm?.admin.name} will be able to sign in again.`}
        confirmLabel="Confirm"
        danger={confirm?.admin.isActive}
        loading={toggleMutation.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && toggleMutation.mutate(confirm.admin)}
      />
    </div>
  );
}
