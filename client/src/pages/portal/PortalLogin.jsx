import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useInvestorAuth } from '../../context/InvestorAuthContext.jsx';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';

export function PortalLogin() {
  const { login, investor } = useInvestorAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (investor) navigate(location.state?.from ?? '/portal', { replace: true });

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await login({ loginId: loginId.trim(), password: password.trim() });
      navigate(me?.must_change_password ? '/portal/account' : (location.state?.from ?? '/portal'), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">IP</div>
        <h1>Investor Portal</h1>
        <p className="muted small">
          Sign in to see your investments, installments and payments.
          <br />
          আপনার বিনিয়োগ, কিস্তি ও পেমেন্ট দেখতে সাইন ইন করুন।
        </p>

        <Alert tone="error">{error}</Alert>

        <Field label="Mobile number or member code" hint="e.g. 01712345678 or INV-000123">
          <Input
            id="loginId"
            autoComplete="username"
            required
            value={loginId}
            onChange={setLoginId}
            placeholder="01712345678 / INV-000123"
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
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" variant="primary" className="block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="muted small" style={{ marginTop: 14, marginBottom: 6 }}>
          First time here, or forgot your password? The office will give you a temporary password (in person or by
          SMS). You will choose your own password at first sign-in. Never share your password with anyone.
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          Staff? <Link to="/login">Admin sign-in →</Link>
        </p>
      </form>
    </div>
  );
}
