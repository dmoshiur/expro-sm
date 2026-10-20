import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { investorsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Button, Card, Field, Input, Modal, Select, Spinner } from '../../components/ui.jsx';
import {
  formatNid,
  isValidBdPhone,
  isValidNid,
  nidHint,
  normalizeBdPhone,
  normalizeNid,
} from '../../utils/format.js';

const EMPTY_NOMINEE = { name: '', relation: '', mobile: '', nid: '', share_percent: '' };

const PROFILE_FIELDS = [
  'name_bangla',
  'email',
  'alternate_mobile',
  'date_of_birth',
  'gender',
  'father_name',
  'mother_name',
  'religion',
  'education',
  'present_address',
  'permanent_address',
];

/**
 * One row in the form. `error` is rendered under the control (never as a
 * generic toast) and the input gets aria-invalid through <Field>.
 */
function Row({ id, label, error, hint, children }) {
  return (
    <Field label={label} error={error} hint={hint}>
      {children}
    </Field>
  );
}

/** NID input: digits only, grouped for readability, length badge underneath. */
function NidInput({ id, value, onChange, error, currentLast4 = null, placeholder = '1990 123456 789' }) {
  const hint = nidHint(value);
  return (
    <div className="nid-field">
      <Input
        id={id}
        value={formatNid(value)}
        onChange={(next) => onChange(normalizeNid(next))}
        placeholder={placeholder}
        inputMode="numeric"
        autoComplete="off"
        aria-describedby={`${id}-hint`}
      />
      <div className="nid-legend">
        <span className={`badge ${hint.tone === 'ok' ? 'ok' : hint.tone === 'warn' ? 'warn' : 'muted'}`}>{hint.text}</span>
        {error ? <span className="error" role="alert">{error}</span> : null}
      </div>
      <div className="small muted" id={`${id}-hint`}>
        Ten digits (old card), 13 (NID) or 17 (smart card). Spaces and dashes are ignored.
        {currentLast4 ? (
          <>
            {' '}Currently on file: <span className="mono">••••••••{currentLast4}</span> — leave blank to keep it.
          </>
        ) : null}
      </div>
    </div>
  );
}

export function InvestorForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { isSuperAdmin } = useAuth();

  const [form, setForm] = useState({
    name: '',
    name_bangla: '',
    mobile: '',
    nid: '',
    address: '',
    notes: '',
    status: 'ACTIVE',
    email: '',
    alternate_mobile: '',
    date_of_birth: '',
    gender: '',
    father_name: '',
    mother_name: '',
    religion: '',
    education: '',
    present_address: '',
    permanent_address: '',
  });
  const [nominees, setNominees] = useState([]);
  const [errors, setErrors] = useState({});
  const [nomineeErrors, setNomineeErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);

  // Portal access for a NEW investor (existing investors are managed from the investor page).
  const [portalEnabled, setPortalEnabled] = useState(true);
  const [portalPassword, setPortalPassword] = useState('');
  const [portalSms, setPortalSms] = useState(false);
  const [createdCreds, setCreatedCreds] = useState(null);

  const existing = useApi(() => (editing ? investorsApi.get(id) : Promise.resolve(null)), [id], { immediate: editing });

  useEffect(() => {
    if (!existing.data) return;
    const { investor, nominees: savedNominees } = existing.data;
    setForm({
      name: investor.name ?? '',
      name_bangla: investor.name_bangla ?? '',
      mobile: investor.mobile ?? '',
      nid: '',
      address: investor.address ?? '',
      notes: investor.notes ?? '',
      status: investor.status ?? 'ACTIVE',
      email: investor.email ?? '',
      alternate_mobile: investor.alternate_mobile ?? '',
      date_of_birth: investor.date_of_birth ? String(investor.date_of_birth).slice(0, 10) : '',
      gender: investor.gender ?? '',
      father_name: investor.father_name ?? '',
      mother_name: investor.mother_name ?? '',
      religion: investor.religion ?? '',
      education: investor.education ?? '',
      present_address: investor.present_address ?? '',
      permanent_address: investor.permanent_address ?? '',
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
  const errorsList = useMemo(
    () =>
      Object.entries(errors)
        .filter(([key]) => !key.includes('['))
        .map(([key, message]) => ({ key, message })),
    [errors],
  );

  const normalizePhoneFields = () => {
    setForm((current) => ({
      ...current,
      mobile: normalizeBdPhone(current.mobile),
      alternate_mobile: current.alternate_mobile ? normalizeBdPhone(current.alternate_mobile) : '',
    }));
  };

  /** Client-side checks; the server remains the authority. */
  const validate = () => {
    const next = {};
    if (!String(form.name).trim()) next.name = 'Enter the investor’s full name';
    if (!form.mobile.trim()) next.mobile = 'Mobile number is required - it is the portal login';
    else if (!isValidBdPhone(form.mobile)) next.mobile = `“${form.mobile}” is not a valid BD mobile. Use 01XXXXXXXXX or +8801XXXXXXXXX.`;
    if (form.alternate_mobile && !isValidBdPhone(form.alternate_mobile)) next.alternate_mobile = 'Use a valid BD mobile (01XXXXXXXXX)';
    if (form.nid && !isValidNid(form.nid)) {
      next.nid = `NID must have 10, 13 or 17 digits (you entered ${normalizeNid(form.nid).length}).`;
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) next.email = 'Enter a valid email address';
    if (form.date_of_birth && form.date_of_birth > new Date().toISOString().slice(0, 10)) {
      next.date_of_birth = 'Date of birth cannot be in the future';
    }
    if (isSuperAdmin) {
      const nomineeFieldErrors = {};
      nominees.forEach((nominee, index) => {
        const rowErrors = {};
        if (!String(nominee.name).trim()) rowErrors.name = 'Nominee name is required';
        if (!String(nominee.relation).trim()) rowErrors.relation = 'Relation is required';
        if (!isValidBdPhone(nominee.mobile)) rowErrors.mobile = 'Enter a valid BD mobile';
        if (nominee.nid && !isValidNid(nominee.nid)) rowErrors.nid = 'NID must be 10, 13 or 17 digits';
        const share = Number(nominee.share_percent);
        if (!Number.isFinite(share) || share <= 0 || share > 100) rowErrors.share_percent = 'Share must be between 0 and 100';
        if (Object.keys(rowErrors).length) nomineeFieldErrors[index] = rowErrors;
      });
      if (Object.keys(nomineeFieldErrors).length) {
        setNomineeErrors(nomineeFieldErrors);
        next.nominees = 'Fix the highlighted nominee rows';
      }
      if (nominees.length && Math.abs(shareTotal - 100) > 0.001) {
        next.nominees = `Nominee shares must total 100% (currently ${shareTotal}%)`;
      }
    }
    return next;
  };

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      const node = formRef.current?.querySelector('[aria-invalid="true"], .field .error');
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setNomineeErrors({});
    const found = validate();
    if (Object.keys(found).length) {
      setErrors(found);
      focusFirstError();
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        mobile: normalizeBdPhone(form.mobile),
        address: form.address || undefined,
        notes: form.notes || undefined,
        status: form.status,
      };
      for (const field of PROFILE_FIELDS) {
        if (form[field]) payload[field] = form[field];
      }
      if (form.nid) payload.nid = normalizeNid(form.nid);

      let investorId = id;
      let createResult = null;
      if (editing) {
        await investorsApi.update(id, payload);
      } else {
        createResult = await investorsApi.create({
          ...payload,
          nominees: isSuperAdmin && nominees.length ? nominees.map(cleanNominee) : undefined,
          portal: { enabled: portalEnabled, password: portalPassword || undefined, sendSms: portalSms },
        });
        investorId = createResult.investor.id;
      }

      if (editing && isSuperAdmin) {
        await investorsApi.replaceNominees(id, nominees.map(cleanNominee));
      }

      toast.success(editing ? 'Investor updated' : 'Investor created');
      if (createResult?.portal?.tempPassword) {
        setCreatedCreds({ ...createResult.portal, investorId, mobile: payload.mobile });
        return;
      }
      navigate(`/investors/${investorId}`);
    } catch (err) {
      const details = err.details && typeof err.details === 'object' ? err.details : {};
      const flat = {};
      const rowErrors = {};
      for (const [key, message] of Object.entries(details)) {
        const match = /^nominees\[(\d+)\]\.(\w+)$/.exec(key);
        if (match) {
          const index = Number(match[1]);
          rowErrors[index] = { ...(rowErrors[index] ?? {}), [match[2]]: message };
        } else if (key === 'constraint') {
          flat.form = `This looks like a duplicate record (${message}).`;
        } else {
          flat[key] = message;
        }
      }
      if (Object.keys(rowErrors).length) {
        setNomineeErrors(rowErrors);
        flat.nominees = flat.nominees ?? 'Fix the highlighted nominee rows';
      }
      if (!Object.keys(flat).length) flat.form = err.message;
      setErrors(flat);
      focusFirstError();
    } finally {
      setBusy(false);
    }
  };

  if (editing && existing.loading) return <Spinner />;
  if (editing && existing.error) return <Alert tone="error">{existing.error.message}</Alert>;

  return (
    <form onSubmit={submit} ref={formRef} noValidate>
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

      {errorsList.length ? (
        <Alert tone="error">
          Please fix {errorsList.length === 1 ? 'this field' : `these ${errorsList.length} fields`}:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {errorsList.map(({ key, message }) => (
              <li key={key}>
                <a href={`#${key}`} style={{ color: 'inherit', textDecoration: 'underline' }}>{message}</a>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid cols-2">
        <Card title="Investor details">
          <Row id="name" label="Full name (English)" error={errors.name}>
            <Input id="name" required maxLength={120} value={form.name} onChange={update('name')} aria-invalid={errors.name ? 'true' : undefined} />
          </Row>
          <Row id="name_bangla" label="Full name (Bangla)" error={errors.name_bangla} hint="Appears on the membership certificate in Bangla.">
            <Input id="name_bangla" maxLength={120} value={form.name_bangla} onChange={update('name_bangla')} placeholder="যেমন: রহিম উদ্দিন" />
          </Row>
          <Row
            id="mobile"
            label="Mobile (portal login)"
            error={errors.mobile}
            hint="017XXXXXXXX or +8801XXXXXXXXX. Spaces, dashes and the country code are normalised automatically."
          >
            <Input
              id="mobile"
              required
              value={form.mobile}
              onChange={update('mobile')}
              onBlur={normalizePhoneFields}
              inputMode="tel"
              placeholder="01712345678"
              aria-invalid={errors.mobile ? 'true' : undefined}
            />
          </Row>
          {isSuperAdmin ? (
            <Field
              label={editing ? 'NID (leave blank to keep current)' : 'NID'}
              hint={editing ? 'Stored encrypted with a blind index for duplicate checks.' : 'Stored encrypted (AES-256-GCM).'}
            >
              <NidInput
                id="nid"
                value={form.nid}
                onChange={update('nid')}
                error={errors.nid}
                currentLast4={editing ? existing.data?.investor?.nid_last4 : null}
              />
            </Field>
          ) : (
            <Alert tone="info">Only a Super Admin can view or change NID details.</Alert>
          )}
          <Row id="address" label="Address (legacy)" error={errors.address} hint="Present and permanent addresses live on the right.">
            <Input id="address" maxLength={500} value={form.address} onChange={update('address')} />
          </Row>
          <Row id="status" label="Status" error={errors.status}>
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
          </Row>
          <Row id="notes" label="Internal notes" error={errors.notes} hint="Staff-only, never shown in the portal.">
            <textarea id="notes" maxLength={2000} value={form.notes} onChange={(event) => update('notes')(event.target.value)} />
          </Row>
        </Card>

        <Card title="Personal & contact details">
          <p className="muted small" style={{ marginTop: 0 }}>
            These appear on the member profile. The investor can also complete them from the portal after signing in.
          </p>
          <div className="form-row">
            <Row id="father_name" label="Father / husband name" error={errors.father_name}>
              <Input id="father_name" maxLength={120} value={form.father_name} onChange={update('father_name')} />
            </Row>
            <Row id="mother_name" label="Mother's name" error={errors.mother_name}>
              <Input id="mother_name" maxLength={120} value={form.mother_name} onChange={update('mother_name')} />
            </Row>
          </div>
          <div className="form-row">
            <Row id="date_of_birth" label="Date of birth" error={errors.date_of_birth}>
              <Input id="date_of_birth" type="date" value={form.date_of_birth} onChange={update('date_of_birth')} />
            </Row>
            <Row id="gender" label="Gender" error={errors.gender}>
              <Select
                id="gender"
                value={form.gender}
                onChange={update('gender')}
                options={[
                  { value: '', label: 'Not set' },
                  { value: 'MALE', label: 'Male' },
                  { value: 'FEMALE', label: 'Female' },
                  { value: 'OTHER', label: 'Other' },
                ]}
              />
            </Row>
          </div>
          <div className="form-row">
            <Row id="religion" label="Religion" error={errors.religion}>
              <Input id="religion" maxLength={60} value={form.religion} onChange={update('religion')} />
            </Row>
            <Row id="education" label="Education" error={errors.education}>
              <Input id="education" maxLength={120} value={form.education} onChange={update('education')} placeholder="e.g. HSC" />
            </Row>
          </div>
          <div className="form-row">
            <Row id="email" label="Email" error={errors.email}>
              <Input id="email" type="email" value={form.email} onChange={update('email')} placeholder="name@example.com" />
            </Row>
            <Row id="alternate_mobile" label="Alternate mobile" error={errors.alternate_mobile}>
              <Input
                id="alternate_mobile"
                value={form.alternate_mobile}
                onChange={update('alternate_mobile')}
                onBlur={normalizePhoneFields}
                inputMode="tel"
                placeholder="01712345678"
              />
            </Row>
          </div>
          <Row id="present_address" label="Present address" error={errors.present_address}>
            <textarea id="present_address" maxLength={500} value={form.present_address} onChange={(event) => update('present_address')(event.target.value)} rows={2} />
          </Row>
          <Row id="permanent_address" label="Permanent address" error={errors.permanent_address} hint="Leave blank if same as present address.">
            <textarea id="permanent_address" maxLength={500} value={form.permanent_address} onChange={(event) => update('permanent_address')(event.target.value)} rows={2} />
          </Row>
        </Card>

        {!editing ? (
          <Card title="Portal access (investor login)">
            <label className="inline small">
              <input type="checkbox" checked={portalEnabled} onChange={(event) => setPortalEnabled(event.target.checked)} />
              Enable portal login for this investor
            </label>
            {portalEnabled ? (
              <>
                <Field
                  label="Temporary password"
                  hint="Leave blank to auto-generate. Minimum 8 characters with a letter and a digit. The investor must change it at first sign-in."
                >
                  <Input value={portalPassword} onChange={setPortalPassword} autoComplete="new-password" placeholder="Auto-generated if blank" />
                </Field>
                <label className="inline small">
                  <input type="checkbox" checked={portalSms} onChange={(event) => setPortalSms(event.target.checked)} />
                  Send login details by SMS to the mobile number above
                </label>
                <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                  After creating, the temporary password is shown once so you can hand it to the investor.
                </p>
              </>
            ) : (
              <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                You can enable it later from the investor page (Portal access card).
              </p>
            )}
          </Card>
        ) : null}

        <Card
          title={`Nominees (${nominees.length}/3)`}
          actions={
            isSuperAdmin && nominees.length < 3 ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setNominees((current) => [...current, { ...EMPTY_NOMINEE }]);
                  setErrors((current) => ({ ...current, nominees: undefined }));
                }}
              >
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
              {nominees.map((nominee, index) => {
                const rowErrors = nomineeErrors[index] ?? {};
                return (
                  <div key={nominee.id ?? index} className="card nominee-row" style={{ margin: 0 }}>
                    <div className="form-row">
                      <Row id={`nominee-${index}-name`} label="Name" error={rowErrors.name}>
                        <Input value={nominee.name} onChange={updateNominee(index, 'name')} aria-invalid={rowErrors.name ? 'true' : undefined} />
                      </Row>
                      <Row id={`nominee-${index}-relation`} label="Relation" error={rowErrors.relation}>
                        <Input value={nominee.relation} onChange={updateNominee(index, 'relation')} placeholder="Spouse" aria-invalid={rowErrors.relation ? 'true' : undefined} />
                      </Row>
                    </div>
                    <div className="form-row">
                      <Row id={`nominee-${index}-mobile`} label="Mobile" error={rowErrors.mobile}>
                        <Input
                          value={nominee.mobile}
                          onChange={updateNominee(index, 'mobile')}
                          onBlur={() => updateNominee(index, 'mobile')(normalizeBdPhone(nominee.mobile))}
                          inputMode="tel"
                          placeholder="01712345678"
                          aria-invalid={rowErrors.mobile ? 'true' : undefined}
                        />
                      </Row>
                      <Row id={`nominee-${index}-share`} label="Share %" error={rowErrors.share_percent}>
                        <Input
                          type="number"
                          min="1"
                          max="100"
                          step="0.01"
                          value={nominee.share_percent}
                          onChange={updateNominee(index, 'share_percent')}
                          aria-invalid={rowErrors.share_percent ? 'true' : undefined}
                        />
                      </Row>
                    </div>
                    <Field label="NID (optional)" hint="10, 13 or 17 digits.">
                      <NidInput
                        id={`nominee-${index}-nid`}
                        value={nominee.nid}
                        onChange={updateNominee(index, 'nid')}
                        error={rowErrors.nid}
                        placeholder="1990 123456 789"
                      />
                    </Field>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setNominees((current) => current.filter((_, i) => i !== index));
                        setNomineeErrors({});
                      }}
                    >
                      Remove nominee
                    </Button>
                  </div>
                );
              })}
              <div className={`alert ${Math.abs(shareTotal - 100) < 0.001 ? 'ok' : 'warn'}`} style={{ marginBottom: 0 }}>
                Shares total <strong>{shareTotal}%</strong> {Math.abs(shareTotal - 100) < 0.001 ? '✓' : '— must equal 100%'}
              </div>
              {errors.nominees ? <div className="error" role="alert">{errors.nominees}</div> : null}
            </div>
          )}
        </Card>
      </div>

      {createdCreds ? (
        <Modal title="Investor portal login ready" onClose={() => navigate(`/investors/${createdCreds.investorId}`)}>
          <Alert tone="ok">
            Share these login details with the investor now - the password is shown <strong>only once</strong>.
          </Alert>
          <div className="muted small">Temporary password</div>
          <div className="code-box">{createdCreds.tempPassword}</div>
          <p className="small">
            Login page: <span className="mono">{createdCreds.login_url}</span>
            <br />
            Login id: mobile <span className="mono">{createdCreds.mobile}</span> or member code{' '}
            <span className="mono">{createdCreds.member_code}</span>
            <br />
            {createdCreds.sms
              ? createdCreds.sms.sent
                ? '✓ Credentials also sent by SMS.'
                : '⚠ SMS was not delivered - please share the password another way.'
              : null}
          </p>
          <div className="inline" style={{ justifyContent: 'flex-end' }}>
            <Button
              type="button"
              className="sm"
              onClick={() => {
                navigator.clipboard?.writeText(createdCreds.tempPassword);
                toast.success('Password copied');
              }}
            >
              Copy password
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={() => navigate(`/investors/${createdCreds.investorId}`)}>
              Go to investor
            </Button>
          </div>
        </Modal>
      ) : null}
    </form>
  );
}

function cleanNominee(nominee) {
  const payload = {
    name: String(nominee.name ?? '').trim(),
    relation: String(nominee.relation ?? '').trim(),
    mobile: normalizeBdPhone(nominee.mobile),
    share_percent: Number(nominee.share_percent),
  };
  // Keep the row id so the API preserves NIDs and nominee photos on save.
  if (nominee.id) payload.id = nominee.id;
  if (nominee.nid) payload.nid = normalizeNid(nominee.nid);
  return payload;
}
