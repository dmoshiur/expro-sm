/**
 * Placeholder pages for drawer items that are not built yet. They are honest
 * about their status and point members to the office for anything urgent.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/ui.jsx';

export function PortalComingSoon({ title, icon, text, related = [] }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
        </div>
      </div>
      <Card className="soon-card">
        <div className="soon-icon" aria-hidden="true">{icon}</div>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Coming soon</h2>
        <p className="muted mx-auto mt-2 max-w-sm">{text}</p>
        <span className="soon-tag">Placeholder</span>
        {related.length ? (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {related.map((item) => (
              <Link key={item.to} className="btn sm" to={item.to}>
                {item.label}
              </Link>
            ))}
          </div>
        ) : null}
      </Card>
    </>
  );
}

export function PortalMyTeam() {
  return (
    <PortalComingSoon
      title="My team"
      icon="☷"
      text="Your team view (referrals and members you bring in) will appear here. Until then, your nominees and profile are available."
      related={[
        { to: '/portal/nominees', label: 'Nominees' },
        { to: '/portal/support', label: 'Ask support' },
      ]}
    />
  );
}

export function PortalAccountTransfers() {
  return (
    <PortalComingSoon
      title="Account transfers"
      icon="⇄"
      text="Moving money between accounts is not available in the portal yet. Use Payment & wallet to see your balance, or request a deposit or withdrawal."
      related={[
        { to: '/portal/payment', label: 'Payment & wallet' },
        { to: '/portal/support', label: 'Ask support' },
      ]}
    />
  );
}

const POLICY = {
  privacy: {
    title: 'Privacy policy',
    icon: '§',
    intro: 'This page will hold the final privacy policy. The draft below describes how we intend to handle your data.',
    sections: [
      ['What we collect', 'Identity details (name, mobile, NID number, photos and signature) recorded by the office, and contact details you add yourself.'],
      ['How we use it', 'To run your investment plan, collect installments, issue receipts and meet legal record-keeping duties.'],
      ['How we protect it', 'Sensitive values such as NID numbers are masked in the portal, and NID scans are encrypted and visible only to the office.'],
      ['Your choices', 'You can update contact details in My profile. Identity changes go through the office, and you can raise a support inquiry at any time.'],
    ],
  },
  terms: {
    title: 'Terms of service',
    icon: '¶',
    intro: 'This page will hold the final terms of service. The draft below is a placeholder and is not a binding agreement.',
    sections: [
      ['Using the portal', 'The portal is for the member named on the account. Keep your password private and sign out on shared devices.'],
      ['Payments and receipts', 'Installment and donation payments go through the approved gateway. A receipt is issued for each successful payment.'],
      ['Records', 'The office record is the reference for your plan. If the portal and the office disagree, contact support.'],
      ['Changes', 'These terms may change. The version shown here is the one in force until a new version is published.'],
    ],
  },
};

export function PortalPolicy({ kind }) {
  const policy = POLICY[kind];
  if (!policy) return null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{policy.title}</h1>
          <p className="muted">Draft placeholder. Final wording is published by the office.</p>
        </div>
      </div>
      <Card>
        <p className="policy-body">{policy.intro}</p>
        {policy.sections.map(([heading, body]) => (
          <div key={heading} className="policy-body">
            <h3>{heading}</h3>
            <p>{body}</p>
          </div>
        ))}
        <p className="small muted mt-4">
          Questions? <Link to="/portal/support">Contact support</Link>.
        </p>
      </Card>
    </>
  );
}
