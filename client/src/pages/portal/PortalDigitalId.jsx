/**
 * Digital ID: a membership card built from the investor's real profile.
 * Sensitive values are masked (mobile, NID). The card prints as one page.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { portalApi } from '../../services/endpoints.js';
import { useApi, useRefreshOnFocus } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Button, Spinner } from '../../components/ui.jsx';
import { formatDate } from '../../utils/format.js';

/** 017XXXXXXXX -> 017•••••XX (first 3, last 2 visible). */
export function maskMobile(mobile) {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (digits.length < 6) return '•••••••••••';
  return `${digits.slice(0, 3)}${'•'.repeat(Math.max(4, digits.length - 5))}${digits.slice(-2)}`;
}

export function PortalDigitalId() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi(() => portalApi.profile(), []);
  useRefreshOnFocus(reload, { intervalMs: 60000 });
  const [copied, setCopied] = useState(false);

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const profile = data?.profile;
  if (!profile) return <Alert tone="error">Your Digital ID could not be loaded. Please try again.</Alert>;

  const active = profile.status === 'ACTIVE' && profile.membership_status === 'APPROVED' && !profile.is_frozen;
  const initials = profile.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(profile.member_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy. Select the member ID and copy it manually.');
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="page-head no-print" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Digital ID</h1>
          <p className="muted">Show this card when you visit the office. Sensitive details stay masked.</p>
        </div>
      </div>

      {!active ? (
        <Alert tone={profile.is_frozen ? 'error' : 'warn'}>
          {profile.is_frozen
            ? 'Your account is frozen, so this ID is not valid for transactions until the office lifts the freeze.'
            : `Membership is ${String(profile.membership_status).toLowerCase()}. Your ID becomes fully valid once it is approved.`}
        </Alert>
      ) : null}

      <div className="id-card" role="img" aria-label={`Digital ID for ${profile.name}, member ${profile.member_code}`}>
        <div className="id-top">
          <span className="id-org">Investor Portal</span>
          <span className="id-chip">{active ? 'Active member' : 'Member'}</span>
        </div>
        <div className="id-body">
          <div className="id-photo">
            {profile.has_photo ? (
              <img src={`${portalApi.photoUrl}?v=${encodeURIComponent(profile.last_login_at ?? '')}`} alt="" />
            ) : (
              <span aria-hidden="true">{initials || '?'}</span>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="id-name">{profile.name}</div>
            {profile.name_bangla ? <div className="id-bn">{profile.name_bangla}</div> : null}
            <div className="id-grid">
              <div>
                <span>Member ID</span>
                <strong className="mono">{profile.member_code}</strong>
              </div>
              <div>
                <span>Member since</span>
                <strong>{formatDate(profile.member_since)}</strong>
              </div>
              <div>
                <span>Mobile</span>
                <strong className="mono">{maskMobile(profile.mobile)}</strong>
              </div>
              <div>
                <span>NID</span>
                <strong className="mono">{profile.nid_last4 ? `•••• ${profile.nid_last4}` : 'Not on file'}</strong>
              </div>
            </div>
          </div>
        </div>
        <div className="id-foot">
          <span>{active ? '✓ Membership verified by the office' : 'Pending verification'}</span>
          <span>{profile.nominees?.length ?? 0} nominee(s)</span>
        </div>
      </div>

      <div className="no-print mt-5 grid grid-cols-2 gap-3">
        <Button className="sm primary" style={{ padding: 12 }} onClick={() => window.print()}>
          Print / save as PDF
        </Button>
        <Button className="sm" style={{ padding: 12 }} onClick={copyCode}>
          {copied ? 'Copied ✓' : 'Copy member ID'}
        </Button>
      </div>
      <p className="no-print small muted mt-4 text-center">
        Need a correction to your details? <Link to="/portal/support">Open a support inquiry</Link>.
      </p>
    </div>
  );
}
