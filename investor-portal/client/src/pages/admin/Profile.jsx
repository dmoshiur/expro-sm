import { useState } from 'react';
import { authApi } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Field, Input, Spinner, Table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

export function Profile() {
  const toast = useToast();
  const { admin, refresh } = useAuth();
  const me = useApi(() => authApi.me(), []);

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>My profile</h1>
        <Badge status="ACTIVE" label={admin?.role} />
        <div className="spacer" />
      </div>

      {admin?.must_change_password ? (
        <Alert tone="warn">You are still using your initial password. Please change it below.</Alert>
      ) : null}

      <div className="grid cols-2">
        <Card title="Account">
          <div className="stack small">
            <div>
              <div className="muted">Name</div>
              <div>{admin?.name}</div>
            </div>
            <div>
              <div className="muted">Email</div>
              <div>{admin?.email}</div>
            </div>
            <div>
              <div className="muted">Role</div>
              <div>{admin?.role}</div>
            </div>
            <div>
              <div className="muted">Session expires</div>
              <div>{me.data?.session?.expiresAt ? formatDateTime(me.data.session.expiresAt) : '—'}</div>
            </div>
          </div>
          <Button
            className="sm"
            style={{ marginTop: 12 }}
            onClick={async () => {
              try {
                await authApi.revokeOtherSessions();
                toast.success('Other sessions revoked');
                me.reload();
              } catch (err) {
                toast.error(err.message);
              }
            }}
          >
            Revoke other sessions
          </Button>
        </Card>

        <ChangePasswordCard
          onDone={() => {
            toast.success('Password changed');
            refresh();
          }}
        />

        <TotpCard
          enabled={Boolean(admin?.totp_enabled)}
          onChanged={() => {
            refresh();
            toast.success('2FA preference updated');
          }}
        />

        <Card title="Recent sessions">
          {me.loading && !me.data ? (
            <Spinner />
          ) : (
            <Table
              rows={me.data?.sessions ?? []}
              empty="No sessions recorded."
              columns={[
                { key: 'created_at', header: 'Started', render: (row) => formatDateTime(row.created_at) },
                { key: 'ip', header: 'IP', mono: true, render: (row) => row.ip ?? '—' },
                { key: 'user_agent', header: 'Device', render: (row) => <span className="small muted">{String(row.user_agent ?? '').slice(0, 48)}</span> },
                { key: 'revoked_at', header: 'State', render: (row) => (row.revoked_at ? <span className="badge muted">{row.revoked_reason ?? 'revoked'}</span> : <span className="badge ok">active</span>) },
              ]}
            />
          )}
        </Card>
      </div>
    </>
  );
}

function ChangePasswordCard({ onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const update = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  return (
    <Card title="Change password">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (form.newPassword !== form.confirm) {
            toast.error('New passwords do not match');
            return;
          }
          setBusy(true);
          try {
            await authApi.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword });
            setForm({ currentPassword: '', newPassword: '', confirm: '' });
            onDone();
          } catch (err) {
            toast.error(err.details?.missing ? `${err.message} Missing: ${err.details.missing.join(', ')}` : err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Current password">
          <Input required type="password" value={form.currentPassword} onChange={update('currentPassword')} />
        </Field>
        <Field label="New password" hint="At least 12 characters with upper, lower, digit and symbol.">
          <Input required type="password" value={form.newPassword} onChange={update('newPassword')} />
        </Field>
        <Field label="Confirm new password">
          <Input required type="password" value={form.confirm} onChange={update('confirm')} />
        </Field>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </Card>
  );
}

function TotpCard({ enabled, onChanged }) {
  const toast = useToast();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const startSetup = async () => {
    setBusy(true);
    try {
      const data = await authApi.totpSetup();
      setSetup(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Two-factor authentication (TOTP)">
      {enabled ? (
        <>
          <p className="small muted">
            Authenticator 2FA is <strong>on</strong>. To turn it off you must confirm your password and a current code.
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await authApi.totpDisable({ password, code });
                setPassword('');
                setCode('');
                onChanged();
              } catch (err) {
                toast.error(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Password">
              <Input required type="password" value={password} onChange={setPassword} />
            </Field>
            <Field label="Current 6-digit code">
              <Input required inputMode="numeric" maxLength={6} value={code} onChange={setCode} />
            </Field>
            <Button type="submit" className="danger sm" disabled={busy}>
              Disable 2FA
            </Button>
          </form>
        </>
      ) : setup ? (
        <>
          <p className="small">
            Add this secret to Google Authenticator, Authy or 1Password (manual entry), then confirm with a generated code.
          </p>
          <div className="code-box" style={{ marginBottom: 8 }}>{setup.secretGrouped}</div>
          <div className="small muted" style={{ marginBottom: 10 }}>
            Algorithm {setup.algorithm} · {setup.digits} digits · {setup.period}s
          </div>
          <details style={{ marginBottom: 10 }}>
            <summary className="small">otpauth:// URI (paste into a QR generator if you prefer)</summary>
            <div className="code-box" style={{ marginTop: 6 }}>{setup.otpauthUri}</div>
          </details>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await authApi.totpConfirm(code);
                toast.success('2FA enabled');
                setSetup(null);
                setCode('');
                onChanged();
              } catch (err) {
                toast.error(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="6-digit code from your app">
              <Input required inputMode="numeric" maxLength={6} value={code} onChange={setCode} />
            </Field>
            <div className="inline">
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Confirm & enable
              </Button>
              <Button type="button" className="sm ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <p className="small muted">
            2FA is <strong>off</strong>. Enabling it protects the portal even if a password leaks; the secret is stored
            AES-256-GCM encrypted.
          </p>
          <Button variant="primary" size="sm" onClick={startSetup} disabled={busy}>
            Set up 2FA
          </Button>
        </>
      )}
    </Card>
  );
}
