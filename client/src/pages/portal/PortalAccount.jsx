import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useInvestorAuth } from '../../context/InvestorAuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Field, Input, Spinner, Table } from '../../components/ui.jsx';
import { formatDate, formatDateTime } from '../../utils/format.js';

export function PortalAccount() {
  const { investor, refresh, mustChangePassword } = useInvestorAuth();
  const me = useApi(() => portalApi.me(), []);

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Account & password</h1>
        <Badge status={investor?.status} />
      </div>

      <div className="grid cols-2">
        <Card title="Account">
          <div className="stack small">
            <div>
              <div className="muted">Name</div>
              <div>{investor?.name}</div>
            </div>
            <div>
              <div className="muted">Member code (login id)</div>
              <div className="mono">{investor?.member_code}</div>
            </div>
            <div>
              <div className="muted">Mobile (login id)</div>
              <div className="mono">{investor?.mobile}</div>
            </div>
            <div>
              <div className="muted">Member since</div>
              <div>{formatDate(investor?.member_since)}</div>
            </div>
            <div>
              <div className="muted">Last login</div>
              <div>{investor?.last_login_at ? formatDateTime(investor.last_login_at) : '—'}</div>
            </div>
            <div>
              <div className="muted">This session expires</div>
              <div>{me.data?.session?.expiresAt ? formatDateTime(me.data.session.expiresAt) : '—'}</div>
            </div>
          </div>
        </Card>

        <ChangePasswordCard
          forced={mustChangePassword}
          onDone={async () => {
            await refresh();
          }}
        />

        <Card title="Recent sessions">
          {me.loading && !me.data ? (
            <Spinner />
          ) : (
            <>
              <Table
                rows={me.data?.sessions ?? []}
                empty="No sessions recorded."
                columns={[
                  { key: 'created_at', header: 'Started', render: (row) => formatDateTime(row.created_at) },
                  { key: 'ip', header: 'IP', mono: true, render: (row) => row.ip ?? '—' },
                  { key: 'user_agent', header: 'Device', render: (row) => <span className="small muted">{String(row.user_agent ?? '').slice(0, 48)}</span> },
                  {
                    key: 'revoked_at',
                    header: 'State',
                    render: (row) =>
                      row.revoked_at ? (
                        <span className="badge muted">{row.revoked_reason ?? 'revoked'}</span>
                      ) : (
                        <span className="badge ok">{row.current ? 'this session' : 'active'}</span>
                      ),
                  },
                ]}
              />
              <RevokeOthersButton onDone={() => me.reload()} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function RevokeOthersButton({ onDone }) {
  const toast = useToast();
  return (
    <Button
      className="sm"
      style={{ marginTop: 12 }}
      onClick={async () => {
        try {
          await portalApi.revokeOtherSessions();
          toast.success('Other sessions signed out');
          onDone();
        } catch (err) {
          toast.error(err.message);
        }
      }}
    >
      Sign out other sessions
    </Button>
  );
}

function ChangePasswordCard({ forced, onDone }) {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const update = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  return (
    <Card title={forced ? 'Set your own password' : 'Change password'}>
      {forced || location.state?.firstLogin ? (
        <Alert tone="info">Welcome! First, replace the temporary password from the office with your own.</Alert>
      ) : null}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (form.newPassword !== form.confirm) {
            toast.error('New password and confirmation do not match');
            return;
          }
          setBusy(true);
          try {
            await portalApi.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword });
            toast.success('Password updated. Other sessions were signed out.');
            setForm({ currentPassword: '', newPassword: '', confirm: '' });
            await onDone();
            if (forced) navigate('/portal', { replace: true });
          } catch (err) {
            toast.error(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={update('currentPassword')} />
        </Field>
        <Field label="New password" hint="At least 8 characters, with a letter and a digit. Do not use your mobile number or member code.">
          <Input type="password" autoComplete="new-password" required value={form.newPassword} onChange={update('newPassword')} />
        </Field>
        <Field label="Repeat new password">
          <Input type="password" autoComplete="new-password" required value={form.confirm} onChange={update('confirm')} />
        </Field>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? 'Saving…' : forced ? 'Set password & continue' : 'Change password'}
        </Button>
      </form>
    </Card>
  );
}
