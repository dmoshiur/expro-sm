/**
 * Investor portal navigation: one source of truth for the drawer (mobile and
 * desktop sidebar) and the fixed bottom bar on phones.
 */
import { NavLink } from 'react-router-dom';

export const PORTAL_DRAWER_GROUPS = [
  {
    title: 'Home',
    items: [
      { to: '/portal', label: 'Dashboard', icon: '▤', exact: true },
      { to: '/portal/digital-id', label: 'Digital ID', icon: '◫' },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/portal/payment', label: 'Payment & wallet', icon: '৳' },
      { to: '/portal/donates', label: 'Donates', icon: '♡' },
      { to: '/portal/transfers', label: 'Account transfers', icon: '⇄' },
      { to: '/portal/investments', label: 'My investments', icon: '▦' },
    ],
  },
  {
    title: 'Family',
    items: [
      { to: '/portal/team', label: 'My team', icon: '☷' },
      { to: '/portal/nominees', label: 'Nominees', icon: '◎' },
    ],
  },
  {
    title: 'Account',
    items: [
      { to: '/portal/profile', label: 'My profile', icon: '☰' },
      { to: '/portal/account', label: 'Account & password', icon: '⚙' },
      { to: '/portal/support', label: 'Support', icon: '✉' },
    ],
  },
  {
    title: 'Legal',
    items: [
      { to: '/portal/privacy', label: 'Privacy policy', icon: '§' },
      { to: '/portal/terms', label: 'Terms of service', icon: '¶' },
    ],
  },
];

export const PORTAL_BOTTOM_NAV = [
  { to: '/portal', label: 'Home', icon: '▤', exact: true },
  { to: '/portal/digital-id', label: 'ID', icon: '◫' },
  { to: '/portal/payment', label: 'Pay', icon: '৳' },
  { to: '/portal/donates', label: 'Donate', icon: '♡' },
  { to: '/portal/profile', label: 'Profile', icon: '☰' },
];

export function PortalDrawerNav({ onNavigate }) {
  return (
    <nav aria-label="Investor portal">
      {PORTAL_DRAWER_GROUPS.map((group) => (
        <div key={group.title}>
          <div className="nav-group">{group.title}</div>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              onClick={onNavigate}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function PortalBottomNav() {
  return (
    <nav className="bottom-nav no-print" aria-label="Quick navigation">
      {PORTAL_BOTTOM_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.exact}
          className={({ isActive }) => (isActive ? 'active' : '')}
        >
          <span className="bn-icon" aria-hidden="true">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
