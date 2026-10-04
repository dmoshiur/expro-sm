import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authService } from '@/services/auth.service';
import { errorMessage } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Alert, Field, Input, Spinner } from '@/components/ui';
import { fieldError } from '@/lib/form';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((state) => state.login);
  const [error, setError] = useState<string | null>(null);
  const [requiresTotp, setRequiresTotp] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    watch,
    formState: { errors, touchedFields, isSubmitted, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
    // Validate when a field is blurred (so an untouched field never nags) and
    // re-validate on every keystroke afterwards, so a "Required" message clears
    // as soon as text is present.
    mode: 'onTouched',
    reValidateMode: 'onChange',
  });

  const email = watch('email');
  const password = watch('password');
  const emailError = fieldError({ message: errors.email?.message, value: email, touched: !!touchedFields.email, submitted: isSubmitted });
  const passwordError = fieldError({ message: errors.password?.message, value: password, touched: !!touchedFields.password, submitted: isSubmitted });

  const [totp, setTotp] = useState('');

  const submit = async (values: FormValues, code?: string) => {
    setError(null);
    try {
      const result = await authService.login({ ...values, ...(code ? { totp: code } : {}) });
      if (result.twoFactorRequired) {
        setRequiresTotp(true);
        return;
      }
      if (result.admin) {
        login(result.admin, result.mustEnable2FA);
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from && from !== '/login' ? from : '/', { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">IP</span>
          <h1 className="text-xl font-semibold text-slate-900">Investor Installment Portal</h1>
          <p className="mt-1 text-sm text-slate-500">Administrator sign in</p>
        </div>

        <div className="card">
          <div className="card-body space-y-4">
            {error ? <Alert kind="error">{error}</Alert> : null}

            {!requiresTotp ? (
              <form className="space-y-4" onSubmit={handleSubmit((values) => submit(values))}>
                <Field label="Email" htmlFor="login-email" error={emailError}>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    placeholder="admin@example.com"
                    {...register('email')}
                  />
                </Field>
                <Field label="Password" htmlFor="login-password" error={passwordError}>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    {...register('password')}
                  />
                </Field>
                <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
                  {isSubmitting ? <Spinner className="h-4 w-4" /> : null}
                  Sign in
                </button>
              </form>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (totp.length === 6) void submit(getValues(), totp);
                }}
              >
                <Alert kind="info">Enter the 6-digit code from your authenticator app.</Alert>
                <Field label="Authenticator code" error={totp.length > 0 && totp.length < 6 ? 'Enter all 6 digits' : undefined}>
                  <Input
                    inputMode="numeric"
                    maxLength={6}
                    autoFocus
                    value={totp}
                    onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="text-center text-lg tracking-[0.4em]"
                  />
                </Field>
                <button type="submit" className="btn-primary w-full" disabled={isSubmitting || totp.length !== 6}>
                  {isSubmitting ? <Spinner className="h-4 w-4" /> : null}
                  Verify and continue
                </button>
                <button type="button" className="btn-ghost w-full" onClick={() => setRequiresTotp(false)}>
                  Back
                </button>
              </form>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          Access is rate limited and locked after repeated failures. Contact a super admin if your account is locked.
        </p>
      </div>
    </div>
  );
}
