import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useInvestorAuth } from '../../context/InvestorAuthContext.jsx';
import { Alert } from '../../components/ui.jsx';
import { DrawerBackdrop, DrawerToggle, useDrawer } from '../../components/Drawer.jsx';
import { PortalBottomNav, PortalDrawerNav } from '../../components/PortalNav.jsx';

/**
 * Investor shell. Phones: top bar + drawer + fixed bottom nav. Desktop: the
 * drawer content is shown as a persistent sidebar.
 */
export function PortalLayout() {
  const { investor, logout, mustChangePassword } = useInvestorAuth();
  const navigate = useNavigate();
  const drawer = useDrawer();

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
      <DrawerBackdrop open={drawer.open} onClose={() => drawer.setOpen(false)} />
      <aside className={`sidebar ${drawer.open ? 'open' : ''}`} id="app-drawer" aria-label="Main menu">
        <button type="button" className="drawer-close" aria-label="Close menu" onClick={() => drawer.setOpen(false)}>
          ✕
        </button>
        <div className="brand">
          <div className="brand-mark">IP</div>
          <div className="brand-text">
            Investor Portal
            <small>My account</small>
          </div>
        </div>
        <div className="drawer-profile">
          <span className="avatar" aria-hidden="true">{initials || '?'}</span>
          <div style={{ minWidth: 0 }}>
            <strong>{investor?.name ?? 'Investor'}</strong>
            <small>{investor?.status ? String(investor.status).toLowerCase() : 'member'}</small>
            <div>
              <span className="member-id">{investor?.member_code ?? '—'}</span>
            </div>
          </div>
        </div>
        <PortalDrawerNav onNavigate={() => drawer.setOpen(false)} />
        <div className="sidebar-footer">Member ID {investor?.member_code}</div>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <DrawerToggle open={drawer.open} onToggle={drawer.toggle} />
          <div className="page-title">My account</div>
          <div className="spacer" />
          <div className="who">
            <div className="avatar" aria-hidden="true">
              {initials || '?'}
            </div>
            <div className="who-text" style={{ textAlign: 'right' }}>
              <div>{investor?.name}</div>
              <div className="role">{investor?.member_code}</div>
            </div>
            <button type="button" className="btn sm" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content portal-content">
          {mustChangePassword ? (
            <Alert tone="warn">
              You are using a temporary password given by the office. Please set your own password on the{' '}
              <Link to="/portal/account">Account &amp; password</Link> page before using the portal.
            </Alert>
          ) : null}
          <Outlet />
        </main>
      </div>

      <PortalBottomNav />
    </div>
  );
}
