import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loading } from './ui';
import type { AdminRole } from '@/lib/types';

/** Blocks unauthenticated users and, optionally, roles below a threshold. */
export function ProtectedRoute({ roles }: { roles?: AdminRole[] }) {
  const { status, admin } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loading label="Checking your session…" />
      </div>
    );
  }
  if (status !== 'authenticated' || !admin) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(admin.role)) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
