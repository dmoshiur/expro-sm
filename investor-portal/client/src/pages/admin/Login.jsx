import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';

export function Login() {
  const { login, admin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (admin) navigate(location.state?.from ?? '/', { replace: true });

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password, totpCode: needsTotp ? totpCode : undefined });
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      if (err.code === 'TOTP_REQUIRED' || /2FA|code/i.test(err.message)) {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">IP</div>
        <h1>Investor Installment Portal</h1>
        <p className="muted small">Staff sign-in. Investors do not log in - they receive payment links by SMS.</p>

        <Alert tone="error">{error}</Alert>

        <Field label="Email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={setEmail}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={setPassword}
            placeholder="••••••••••••"
          />
        </Field>

        {needsTotp ? (
          <Field label="2FA code" hint="6 digits from Google Authenticator / Authy">
            <Input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={totpCode}
              onChange={setTotpCode}
              placeholder="123456"
            />
          </Field>
        ) : null}

        <Button type="submit" variant="primary" className="block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>
          Failed attempts are rate limited and the account locks after repeated failures.
        </p>
      </form>
    </div>
  );
}
