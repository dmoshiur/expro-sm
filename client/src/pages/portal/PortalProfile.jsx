import { useEffect, useRef, useState } from 'react';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useAction } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '../../components/ui.jsx';
import { formatDate, formatDateTime } from '../../utils/format.js';

const GENDER_LABELS = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other' };

export function PortalProfile() {
  const toast = useToast();
  const action = useAction();
  const { data, loading, error, reload } = useApi(() => portalApi.profile(), []);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [photoBust, setPhotoBust] = useState(0);
  const photoInput = useRef(null);
  const scanInput = useRef(null);

  useEffect(() => {
    if (!data) return;
    const p = data.profile;
    setForm({
      email: p.email ?? '',
      alternate_mobile: p.alternate_mobile ?? '',
      date_of_birth: p.date_of_birth ?? '',
      gender: p.gender ?? '',
      father_name: p.father_name ?? '',
      mother_name: p.mother_name ?? '',
      religion: p.religion ?? '',
      education: p.education ?? '',
      present_address: p.present_address ?? '',
      permanent_address: p.permanent_address ?? '',
    });
  }, [data]);

  if (error) return <Alert tone="error">{error.message}</Alert>;
  if (loading || !data || !form) return <Spinner />;
  const { profile, completion } = data;
  const update = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  const save = async (event) => {
    event.preventDefault();
    setErrors({});
    try {
      await action.run(() => portalApi.updateProfile(form));
      toast.success('Profile updated');
      reload();
    } catch (err) {
      if (err.details && typeof err.details === 'object') setErrors(err.details);
      toast.error(err.message);
    }
  };

  const upload = async (file, kind) => {
    if (!file) return;
    try {
      await action.run(() => (kind === 'photo' ? portalApi.uploadPhoto(file) : portalApi.uploadNidScan(file)));
      toast.success(kind === 'photo' ? 'Photo uploaded' : 'NID scan uploaded (stored encrypted)');
      setPhotoBust((n) => n + 1);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>My profile</h1>
        <Badge status={profile.status} />
        <span className="badge info">{profile.member_code}</span>
      </div>

      <div className="grid cols-2">
        <div className="stack">
          <Card title="👤 Personal information">
            <div className="stack small">
              <Info label="Full name" value={profile.name} />
              <Info label="Member code" value={<span className="mono">{profile.member_code}</span>} />
              <Info label="Mobile (login)" value={<span className="mono">{profile.mobile}</span>} />
              <Info label="NID" value={profile.nid_last4 ? `••••••••${profile.nid_last4}` : 'Not on file - please give it to the office'} />
              <Info label="Member since" value={formatDate(profile.member_since)} />
              <Info label="Last login" value={profile.last_login_at ? formatDateTime(profile.last_login_at) : '—'} />
            </div>
            <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
              Name, mobile number and NID can only be changed by the office (to protect your account).
            </p>
          </Card>

          <Card title="🪪 Documents">
            <div className="form-row">
              <div>
                <div className="muted small">Photo</div>
                {profile.has_photo ? (
                  <img
                    src={`${portalApi.photoUrl}?v=${photoBust}`}
                    alt="My photo"
                    style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)', marginTop: 6 }}
                  />
                ) : (
                  <div className="empty" style={{ marginTop: 6 }}>No photo</div>
                )}
                <input ref={photoInput} type="file" accept="image/jpeg,image/png" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0], 'photo')} />
                <div style={{ marginTop: 8 }}>
                  <Button className="sm" onClick={() => photoInput.current?.click()} disabled={action.busy}>
                    Upload photo (max 2 MB)
                  </Button>
                </div>
              </div>
              <div>
                <div className="muted small">NID scan (encrypted)</div>
                <div style={{ marginTop: 6 }}>{profile.has_nid_scan ? <span className="badge ok">On file ✓</span> : <span className="badge warn">Not uploaded</span>}</div>
                <input ref={scanInput} type="file" accept="image/jpeg,image/png,application/pdf" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0], 'scan')} />
                <div className="inline" style={{ marginTop: 8 }}>
                  <Button className="sm" onClick={() => scanInput.current?.click()} disabled={action.busy}>
                    Upload scan
                  </Button>
                  {profile.has_nid_scan ? (
                    <Button className="sm ghost" onClick={() => window.open(portalApi.nidScanUrl, '_blank', 'noopener')}>
                      View scan
                    </Button>
                  ) : null}
                </div>
                <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                  Your scan is stored encrypted and only you and authorised office staff can see it.
                </p>
              </div>
            </div>
          </Card>

          <Card title={`Nominees (${profile.nominees.length})`}>
            {profile.nominees.length === 0 ? (
              <p className="muted small">No nominees recorded. Please contact the office to add a nominee - this protects your family.</p>
            ) : (
              <div className="stack">
                {profile.nominees.map((nominee) => (
                  <div key={nominee.id} className="card" style={{ margin: 0, padding: 12 }}>
                    <div className="inline">
                      <strong>{nominee.name}</strong>
                      <span className="badge info">{nominee.share_percent}%</span>
                    </div>
                    <div className="small muted">
                      {nominee.relation} · <span className="mono">{nominee.mobile}</span>
                      {nominee.nid_last4 ? ` · NID ••••${nominee.nid_last4}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
              Nominee changes are done by the office after verifying identity.
            </p>
          </Card>
        </div>

        <form onSubmit={save}>
          <Card
            title="✏️ Complete / update my details"
            actions={
              <span className="small muted">
                {completion.percent}% complete
              </span>
            }
          >
            <div className="progress" style={{ marginBottom: 14 }}>
              <span style={{ width: `${completion.percent}%` }} />
            </div>
            <div className="form-row">
              <Field label="Father / husband name" error={errors.father_name}>
                <Input value={form.father_name} onChange={update('father_name')} maxLength={120} />
              </Field>
              <Field label="Mother's name" error={errors.mother_name}>
                <Input value={form.mother_name} onChange={update('mother_name')} maxLength={120} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Date of birth" error={errors.date_of_birth}>
                <Input type="date" value={form.date_of_birth} onChange={update('date_of_birth')} />
              </Field>
              <Field label="Gender" error={errors.gender}>
                <Select
                  value={form.gender}
                  onChange={update('gender')}
                  options={[
                    { value: '', label: 'Select…' },
                    ...Object.entries(GENDER_LABELS).map(([value, label]) => ({ value, label })),
                  ]}
                />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Religion" error={errors.religion}>
                <Input value={form.religion} onChange={update('religion')} maxLength={60} />
              </Field>
              <Field label="Education" error={errors.education}>
                <Input value={form.education} onChange={update('education')} maxLength={120} placeholder="e.g. HSC" />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Email" error={errors.email}>
                <Input type="email" value={form.email} onChange={update('email')} placeholder="you@example.com" />
              </Field>
              <Field label="Alternate mobile" error={errors.alternate_mobile}>
                <Input value={form.alternate_mobile} onChange={update('alternate_mobile')} placeholder="01712345678" />
              </Field>
            </div>
            <Field label="Present address" error={errors.present_address}>
              <Input value={form.present_address} onChange={update('present_address')} maxLength={500} />
            </Field>
            <Field label="Permanent address" error={errors.permanent_address}>
              <Input value={form.permanent_address} onChange={update('permanent_address')} maxLength={500} />
            </Field>
            <Button type="submit" variant="primary" size="sm" disabled={action.busy}>
              {action.busy ? 'Saving…' : 'Save changes'}
            </Button>
          </Card>
        </form>
      </div>
    </>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <div className="muted">{label}</div>
      <div>{value ?? '—'}</div>
    </div>
  );
}
