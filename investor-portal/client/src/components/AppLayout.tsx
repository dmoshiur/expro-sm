import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth';
import { initials } from '@/lib/format';
import { Alert } from './ui';

const NAV: Array<{ to: string; label: string; roles?: string[] }> = [
  { to: '/', label: 'Dashboard' },
  { to: '/investors', label: 'Investors' },
  { to: '/investments', label: 'Investments' },
  { to: '/payments', label: 'Payments' },
  { to: '/reports/due', label: 'Due & overdue' },
  { to: '/reports/collections', label: 'Collections' },
  { to: '/audit', label: 'Audit log', roles: ['SUPER_ADMIN'] },
  { to: '/admins', label: 'Admins', roles: ['SUPER_ADMIN'] },
  { to: '/settings', label: 'Settings', roles: ['SUPER_ADMIN'] },
];

export function AppLayout() {
  const { admin, mustEnable2FA } = useAuth();
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const links = NAV.filter((item) => !item.roles || (admin && item.roles.includes(admin.role)));

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">IP</span>
          <span className="text-sm font-semibold text-slate-900">Investor Portal</span>
        </div>
        <nav className="flex-1 space-y-1 px-2 py-2">
          {links.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                clsx(
                  'block rounded-lg px-3 py-2 text-sm font-medium transition',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <NavLink to="/profile" className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-slate-50">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
              {admin ? initials(admin.name) : '?'}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-800">{admin?.name}</span>
              <span className="block truncate text-xs text-slate-500">{admin?.role.replace('_', ' ')}</span>
            </span>
          </NavLink>
          <button type="button" className="btn-ghost mt-1 w-full justify-start" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <NavLink to="/" className="text-sm font-semibold text-slate-900">
              Investor Portal
            </NavLink>
          </div>
          <div className="hidden text-sm text-slate-500 md:block">Installment collection · Asia/Dhaka</div>
          <div className="flex items-center gap-2 md:hidden">
            <NavLink to="/profile" className="btn-secondary">
              Profile
            </NavLink>
            <button type="button" className="btn-secondary" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6">
          {mustEnable2FA ? (
            <div className="mb-4">
              <Alert kind="warning">
                Two-factor authentication is not enabled for your account.{' '}
                <NavLink to="/profile" className="link">
                  Set it up now
                </NavLink>{' '}
                to protect investor data.
              </Alert>
            </div>
          ) : null}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
