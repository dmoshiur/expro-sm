import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useInvestorAuth } from '../../context/InvestorAuthContext.jsx';
import { Alert } from '../../components/ui.jsx';

const NAV = [
  { to: '/portal', label: 'Overview', icon: '▤', exact: true },
  { to: '/portal/profile', label: 'My profile', icon: '☰' },
  { to: '/portal/investments', label: 'Investments', icon: '▦' },
  { to: '/portal/installments', label: 'Installments', icon: '≡' },
  { to: '/portal/payments', label: 'Payments', icon: '৳' },
  { to: '/portal/wallet', label: 'Wallet', icon: '◈' },
  { to: '/portal/support', label: 'Support', icon: '✉' },
  { to: '/portal/account', label: 'Account & password', icon: '⚙' },
];

export function PortalLayout() {
  const { investor, logout, mustChangePassword } = useInvestorAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/portal/login', { replace: true });
  };

  const initials = (investor?.name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">IP</div>
          <div className="brand-text">
            Investor Portal
            <small>My account</small>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.exact} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">{investor?.member_code}</div>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <div className="page-title">My account</div>
          <div className="spacer" />
          <div className="who">
            <div className="avatar" aria-hidden="true">
              {initials || '?'}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div>{investor?.name}</div>
              <div className="role">{investor?.member_code}</div>
            </div>
            <button type="button" className="btn sm" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          {mustChangePassword ? (
            <Alert tone="warn">
              You are using a temporary password given by the office. Please set your own password below before using
              the portal.
            </Alert>
          ) : null}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
