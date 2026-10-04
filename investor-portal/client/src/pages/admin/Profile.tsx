import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authService } from '@/services/auth.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import { useAuthStore } from '@/store/auth';
import { formatDateTime } from '@/lib/format';
import { Alert, Field, Input, Spinner } from '@/components/ui';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(10, 'At least 10 characters')
      .regex(/[A-Za-z]/, 'Must contain a letter')
      .regex(/[0-9]/, 'Must contain a number'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
type FormValues = z.infer<typeof schema>;

export default function Profile() {
  const { admin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const refreshProfile = useAuthStore((state) => state.refreshProfile);
  const [setup, setSetup] = useState<{ qrDataUrl: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const changePassword = useMutation({
    mutationFn: (values: FormValues) => authService.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
    onSuccess: async () => {
      toast.success('Password changed. Please sign in again.');
      reset();
      useAuthStore.getState().clear();
      navigate('/login', { replace: true });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const startSetup = useMutation({
    mutationFn: authService.setupTwoFactor,
    onSuccess: (data) => setSetup(data),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const verify = useMutation({
    mutationFn: () => authService.verifyTwoFactor(code),
    onSuccess: async () => {
      toast.success('Two-factor authentication enabled');
      setSetup(null);
      setCode('');
      await refreshProfile();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const disable = useMutation({
    mutationFn: () => authService.disableTwoFactor(password),
    onSuccess: async () => {
      toast.success('Two-factor authentication disabled');
      setPassword('');
      await refreshProfile();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">My account</h1>
        <p className="text-sm text-slate-500">Password and two-factor authentication.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Profile</h2>
          </div>
          <div className="card-body space-y-2 text-sm">
            <p><span className="text-slate-500">Name:</span> {admin?.name}</p>
            <p><span className="text-slate-500">Email:</span> {admin?.email}</p>
            <p><span className="text-slate-500">Role:</span> {admin?.role.replace('_', ' ')}</p>
            <p><span className="text-slate-500">Last sign in:</span> {admin?.lastLoginAt ? formatDateTime(admin.lastLoginAt) : '—'}</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Change password</h2>
          </div>
          <form className="card-body space-y-4" onSubmit={handleSubmit((values) => changePassword.mutate(values))}>
            <Field label="Current password" error={errors.currentPassword?.message}>
              <Input type="password" autoComplete="current-password" {...register('currentPassword')} />
            </Field>
            <Field label="New password" error={errors.newPassword?.message} hint="At least 10 characters, one letter and one number">
              <Input type="password" autoComplete="new-password" {...register('newPassword')} />
            </Field>
            <Field label="Confirm new password" error={errors.confirmPassword?.message}>
              <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
            </Field>
            <Alert kind="warning">Changing your password signs out every device, including this one.</Alert>
            <button type="submit" className="btn-primary" disabled={changePassword.isPending}>
              {changePassword.isPending ? <Spinner className="h-4 w-4" /> : null}
              Change password
            </button>
          </form>
        </div>

        <div className="card lg:col-span-2">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Two-factor authentication (TOTP)</h2>
            {admin?.twoFAEnabled ? <span className="badge bg-emerald-50 text-emerald-700">Enabled</span> : <span className="badge bg-amber-50 text-amber-700">Not enabled</span>}
          </div>
          <div className="card-body space-y-4">
            {!admin?.twoFAEnabled ? (
              setup ? (
                <div className="grid gap-4 sm:grid-cols-[auto,1fr]">
                  <img src={setup.qrDataUrl} alt="2FA QR code" className="h-44 w-44 rounded-lg border border-slate-200 bg-white p-2" />
                  <div className="space-y-3">
                    <p className="text-sm text-slate-600">
                      Scan the QR code with Google Authenticator, Authy or 1Password, then enter the 6-digit code to confirm.
                    </p>
                    <p className="break-all rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-600">{setup.otpauthUrl}</p>
                    <div className="flex items-end gap-2">
                      <Field label="6-digit code">
                        <Input inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className="w-32 text-center tracking-widest" />
                      </Field>
                      <button type="button" className="btn-primary" disabled={code.length !== 6 || verify.isPending} onClick={() => verify.mutate()}>
                        {verify.isPending ? <Spinner className="h-4 w-4" /> : null}
                        Verify & enable
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <Alert kind="warning">Two-factor authentication is strongly recommended for accounts that can see investor data.</Alert>
                  <button type="button" className="btn-primary" onClick={() => startSetup.mutate()} disabled={startSetup.isPending}>
                    {startSetup.isPending ? <Spinner className="h-4 w-4" /> : null}
                    Set up 2FA
                  </button>
                </div>
              )
            ) : (
              <div className="max-w-md space-y-3">
                <p className="text-sm text-slate-600">Enter your password to disable 2FA. This is audited.</p>
                <Field label="Password">
                  <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </Field>
                <button type="button" className="btn-danger" disabled={!password || disable.isPending} onClick={() => disable.mutate()}>
                  {disable.isPending ? <Spinner className="h-4 w-4" /> : null}
                  Disable 2FA
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
