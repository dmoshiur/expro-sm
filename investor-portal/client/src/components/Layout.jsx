import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '▤', exact: true },
  { group: 'Investors' },
  { to: '/investors', label: 'Investors', icon: '☰' },
  { to: '/investments', label: 'Investments', icon: '▦' },
  { to: '/installments', label: 'Installments', icon: '≡' },
  { group: 'Money' },
  { to: '/payments', label: 'Payments', icon: '৳' },
  { to: '/reports/collections', label: 'Collections', icon: '◔' },
  { to: '/reports/due', label: 'Due & overdue', icon: '⏱' },
  { group: 'Administration', roles: ['SUPER_ADMIN'] },
  { to: '/admins', label: 'Admins', icon: '⚙', roles: ['SUPER_ADMIN'] },
  { to: '/audit', label: 'Audit log', icon: '🛡', roles: ['SUPER_ADMIN'] },
  { to: '/sms', label: 'SMS log', icon: '✉', roles: ['SUPER_ADMIN'] },
  { to: '/system', label: 'System & jobs', icon: '⟳', roles: ['SUPER_ADMIN'] },
];

export function Layout() {
  const { admin, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">IP</div>
          <div className="brand-text">
            Investor Portal
            <small>Installment collection</small>
          </div>
        </div>
        <nav>
          {NAV.filter((item) => !item.roles || item.roles.includes(admin?.role)).map((item) =>
            item.group ? (
              <div className="nav-group" key={item.group}>
                {item.group}
              </div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.exact} className={({ isActive }) => (isActive ? 'active' : '')}>
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-footer">
          Asia/Dhaka · poisha-accurate
        </div>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <div className="page-title">Investor Installment Portal</div>
          <div className="spacer" />
          <div className="who">
            <div style={{ textAlign: 'right' }}>
              <div>{admin?.name}</div>
              <div className="role">{admin?.role?.replace('_', ' ')}</div>
            </div>
            <NavLink className="btn sm" to="/profile">
              Profile
            </NavLink>
            <button type="button" className="btn sm" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
