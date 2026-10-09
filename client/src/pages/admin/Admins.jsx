import { useState } from 'react';
import { adminsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, ConfirmButton, Field, Input, Modal, Select, Spinner, Table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const ROLE_INFO = {
  SUPER_ADMIN: 'Everything, including admins, nominees, NID images and the audit log.',
  ACCOUNTANT: 'Investments, installments, manual payments, payment links, reports. No nominee/NID editing.',
  VIEWER: 'Read-only dashboards and lists with masked personal data.',
};

export function Admins() {
  const toast = useToast();
  const { admin: me } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);

  const { data, loading, error, reload } = useApi(() => adminsApi.list({ limit: 100 }), []);

  const toggleActive = async (row) => {
    try {
      await adminsApi.update(row.id, { is_active: !row.is_active, disabled_reason: row.is_active ? 'Disabled by Super Admin' : undefined });
      toast.success(row.is_active ? `${row.name} disabled` : `${row.name} enabled`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const changeRole = async (row, role) => {
    try {
      await adminsApi.update(row.id, { role });
      toast.success(`${row.name} is now ${role}`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Admins</h1>
        <div className="spacer" />
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          + New admin
        </Button>
      </div>

      <Alert tone="error">{error?.message}</Alert>
      {loading && !data ? (
        <Spinner />
      ) : (
        <Card title="Staff accounts">
          <Table
            rows={data?.items ?? []}
            empty="No admins."
            columns={[
              { key: 'name', header: 'Name' },
              { key: 'email', header: 'Email' },
              {
                key: 'role',
                header: 'Role',
                render: (row) => (
                  <select
                    value={row.role}
                    onChange={(e) => changeRole(row, e.target.value)}
                    disabled={row.id === me?.id}
                    className="small"
                    style={{ width: 150 }}
                  >
                    <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                    <option value="ACCOUNTANT">ACCOUNTANT</option>
                    <option value="VIEWER">VIEWER</option>
                  </select>
                ),
              },
              { key: 'totp_enabled', header: '2FA', render: (row) => (row.totp_enabled ? <span className="badge ok">on</span> : <span className="badge warn">off</span>) },
              { key: 'is_active', header: 'Status', render: (row) => <Badge status={row.is_active ? 'ACTIVE' : 'INACTIVE'} /> },
              { key: 'last_login_at', header: 'Last login', render: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : 'never') },
              { key: 'locked_until', header: 'Locked until', render: (row) => (row.locked_until ? formatDateTime(row.locked_until) : '—') },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                    <Button className="sm ghost" onClick={() => setResetTarget(row)}>
                      Reset password
                    </Button>
                    {row.totp_enabled ? (
                      <ConfirmButton
                        className="btn ghost sm"
                        confirmText="Reset 2FA?"
                        onConfirm={async () => {
                          try {
                            await adminsApi.resetTotp(row.id);
                            toast.success(`2FA reset for ${row.name}`);
                            reload();
                          } catch (err) {
                            toast.error(err.message);
                          }
                        }}
                      >
                        Reset 2FA
                      </ConfirmButton>
                    ) : null}
                    <ConfirmButton
                      className="btn ghost sm"
                      confirmText="Revoke sessions?"
                      onConfirm={async () => {
                        try {
                          await adminsApi.revokeSessions(row.id);
                          toast.success('Sessions revoked');
                        } catch (err) {
                          toast.error(err.message);
                        }
                      }}
                    >
                      Revoke sessions
                    </ConfirmButton>
                    {row.is_active ? (
                      <Button className="sm danger" onClick={() => toggleActive(row)} disabled={row.id === me?.id}>
                        Disable
                      </Button>
                    ) : (
                      <Button className="sm" onClick={() => toggleActive(row)}>
                        Enable
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
          <div className="stack small" style={{ marginTop: 14 }}>
            {Object.entries(ROLE_INFO).map(([role, description]) => (
              <div key={role}>
                <span className="badge info">{role}</span> <span className="muted">{description}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {createOpen ? <CreateAdminModal onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); reload(); }} /> : null}
      {resetTarget ? <ResetPasswordModal admin={resetTarget} onClose={() => setResetTarget(null)} onDone={() => setResetTarget(null)} /> : null}
    </>
  );
}

function CreateAdminModal({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'ACCOUNTANT' });
  const [busy, setBusy] = useState(false);
  const update = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await adminsApi.create(form);
      toast.success('Admin created');
      onDone();
    } catch (err) {
      toast.error(err.details?.missing ? `${err.message} (${err.details.missing.join(', ')})` : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New admin" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <Input required value={form.name} onChange={update('name')} maxLength={120} />
        </Field>
        <Field label="Email">
          <Input required type="email" value={form.email} onChange={update('email')} />
        </Field>
        <Field
          label="Temporary password"
          hint="At least 12 characters with upper, lower, digit and symbol. The admin must change it after first login."
        >
          <Input required type="text" value={form.password} onChange={update('password')} />
        </Field>
        <Field label="Role">
          <Select
            value={form.role}
            onChange={update('role')}
            options={[
              { value: 'SUPER_ADMIN', label: 'SUPER_ADMIN' },
              { value: 'ACCOUNTANT', label: 'ACCOUNTANT' },
              { value: 'VIEWER', label: 'VIEWER' },
            ]}
          />
        </Field>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? 'Creating…' : 'Create admin'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ admin, onClose, onDone }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Reset password · ${admin.name}`} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await adminsApi.resetPassword(admin.id, { newPassword: password, mustChange });
            toast.success('Password reset; all their sessions were revoked');
            onDone();
          } catch (err) {
            toast.error(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="New password" hint="Minimum 12 characters, mixed case, digit and symbol.">
          <Input required type="text" value={password} onChange={setPassword} />
        </Field>
        <label className="inline small">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} /> Force a change on next login
        </label>
        <div className="inline" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <Button type="button" className="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            Reset
          </Button>
        </div>
      </form>
    </Modal>
  );
}
