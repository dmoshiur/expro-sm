import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { investorsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../../components/ui.jsx';

const EMPTY_NOMINEE = { name: '', relation: '', mobile: '', nid: '', share_percent: '' };

export function InvestorForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { isSuperAdmin } = useAuth();

  const [form, setForm] = useState({ name: '', mobile: '', nid: '', address: '', notes: '', status: 'ACTIVE' });
  const [nominees, setNominees] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const existing = useApi(() => (editing ? investorsApi.get(id) : Promise.resolve(null)), [id], { immediate: editing });

  useEffect(() => {
    if (!existing.data) return;
    const { investor, nominees: savedNominees } = existing.data;
    setForm({
      name: investor.name ?? '',
      mobile: investor.mobile ?? '',
      nid: '',
      address: investor.address ?? '',
      notes: investor.notes ?? '',
      status: investor.status ?? 'ACTIVE',
    });
    setNominees(
      (savedNominees ?? []).map((n) => ({
        id: n.id,
        name: n.name,
        relation: n.relation,
        mobile: n.mobile,
        nid: '',
        share_percent: n.share_percent,
      })),
    );
  }, [existing.data]);

  const update = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));
  const updateNominee = (index, field) => (value) =>
    setNominees((current) => current.map((nominee, i) => (i === index ? { ...nominee, [field]: value } : nominee)));

  const shareTotal = nominees.reduce((sum, nominee) => sum + (Number(nominee.share_percent) || 0), 0);

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        mobile: form.mobile,
        address: form.address || undefined,
        notes: form.notes || undefined,
        status: form.status,
      };
      if (form.nid) payload.nid = form.nid;

      let investorId = id;
      if (editing) {
        await investorsApi.update(id, payload);
      } else {
        const result = await investorsApi.create({
          ...payload,
          nominees: isSuperAdmin && nominees.length ? nominees.map(cleanNominee) : undefined,
        });
        investorId = result.investor.id;
      }

      if (editing && isSuperAdmin) {
        const total = nominees.reduce((sum, nominee) => sum + (Number(nominee.share_percent) || 0), 0);
        if (nominees.length && Math.abs(total - 100) > 0.001) {
          setErrors({ nominees: `Nominee shares must total 100% (currently ${total}%)` });
          setBusy(false);
          return;
        }
        await investorsApi.replaceNominees(id, nominees.map(cleanNominee));
      }

      toast.success(editing ? 'Investor updated' : 'Investor created');
      navigate(`/investors/${investorId}`);
    } catch (err) {
      if (err.details && typeof err.details === 'object') setErrors(err.details);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (editing && existing.loading) return <Spinner />;
  if (editing && existing.error) return <Alert tone="error">{existing.error.message}</Alert>;

  return (
    <form onSubmit={submit}>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>{editing ? 'Edit investor' : 'New investor'}</h1>
        <div className="spacer" />
        <Button type="button" className="sm" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create investor'}
        </Button>
      </div>

      <Alert tone="error">
        {errors.name || errors.mobile || errors.nid || errors.nominees || errors.status ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {['name', 'mobile', 'nid', 'status', 'nominees'].map((key) =>
              errors[key] ? <li key={key}>{errors[key]}</li> : null,
            )}
          </ul>
        ) : null}
      </Alert>

      <div className="grid cols-2">
        <Card title="Investor details">
          <Field label="Full name" error={errors.name}>
            <Input id="name" required maxLength={120} value={form.name} onChange={update('name')} />
          </Field>
          <Field label="Mobile" error={errors.mobile} hint="Bangladeshi number, e.g. 01712345678. Used to send payment links.">
            <Input id="mobile" required value={form.mobile} onChange={update('mobile')} placeholder="01712345678" />
          </Field>
          {isSuperAdmin ? (
            <Field
              label={editing ? 'NID (leave blank to keep current)' : 'NID'}
              error={errors.nid}
              hint="10, 13 or 17 digits. Stored encrypted (AES-256-GCM) with a blind index for duplicate checks."
            >
              <Input id="nid" value={form.nid} onChange={update('nid')} placeholder="1990123456789" />
            </Field>
          ) : (
            <Alert tone="info">Only a Super Admin can view or change NID details.</Alert>
          )}
          <Field label="Address" error={errors.address}>
            <Input id="address" maxLength={500} value={form.address} onChange={update('address')} />
          </Field>
          <Field label="Status" error={errors.status}>
            <Select
              id="status"
              value={form.status}
              onChange={update('status')}
              options={[
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive' },
                { value: 'CLOSED', label: 'Closed' },
              ]}
            />
          </Field>
          <Field label="Internal notes" error={errors.notes}>
            <textarea id="notes" maxLength={2000} value={form.notes} onChange={(e) => update('notes')(e.target.value)} />
          </Field>
        </Card>

        <Card
          title={`Nominees (${nominees.length}/3)`}
          actions={
            isSuperAdmin && nominees.length < 3 ? (
              <Button type="button" size="sm" onClick={() => setNominees((current) => [...current, { ...EMPTY_NOMINEE }])}>
                + Add nominee
              </Button>
            ) : null
          }
        >
          {!isSuperAdmin ? (
            <Alert tone="info">
              Nominee details are restricted to Super Admins. An accountant can see that nominees exist but cannot change them.
            </Alert>
          ) : nominees.length === 0 ? (
            <p className="muted small">No nominees. You can add up to 3; their shares must total exactly 100%.</p>
          ) : (
            <div className="stack">
              {nominees.map((nominee, index) => (
                <div key={nominee.id ?? index} className="card" style={{ margin: 0, background: 'var(--surface-2)' }}>
                  <div className="form-row">
                    <Field label="Name">
                      <Input value={nominee.name} onChange={updateNominee(index, 'name')} />
                    </Field>
                    <Field label="Relation">
                      <Input value={nominee.relation} onChange={updateNominee(index, 'relation')} placeholder="Spouse" />
                    </Field>
                  </div>
                  <div className="form-row">
                    <Field label="Mobile">
                      <Input value={nominee.mobile} onChange={updateNominee(index, 'mobile')} />
                    </Field>
                    <Field label="Share %">
                      <Input
                        type="number"
                        min="1"
                        max="100"
                        step="0.01"
                        value={nominee.share_percent}
                        onChange={updateNominee(index, 'share_percent')}
                      />
                    </Field>
                    <Field label="NID (optional)">
                      <Input value={nominee.nid} onChange={updateNominee(index, 'nid')} />
                    </Field>
                  </div>
                  <Button type="button" className="danger sm" onClick={() => setNominees((current) => current.filter((_, i) => i !== index))}>
                    Remove nominee
                  </Button>
                </div>
              ))}
              <div className={`alert ${Math.abs(shareTotal - 100) < 0.001 ? 'ok' : 'warn'}`} style={{ marginBottom: 0 }}>
                Shares total <strong>{shareTotal}%</strong> {Math.abs(shareTotal - 100) < 0.001 ? '✓' : '— must equal 100%'}
              </div>
            </div>
          )}
        </Card>
      </div>
    </form>
  );
}

function cleanNominee(nominee) {
  const payload = {
    name: nominee.name,
    relation: nominee.relation,
    mobile: nominee.mobile,
    share_percent: Number(nominee.share_percent),
  };
  if (nominee.nid) payload.nid = nominee.nid;
  return payload;
}
