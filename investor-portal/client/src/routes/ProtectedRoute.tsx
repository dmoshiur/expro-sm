/**
 * Route guard.
 *
 * Renders the child routes when the session is established, redirects to
 * /login (remembering where the user was going) when it is not, and enforces an
 * optional role allow-list. The API re-checks every permission server-side - the
 * guard only keeps the UI from showing pages a role cannot use.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loading } from '@/components/ui';
import type { AdminRole } from '@/lib/types';

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

export default ProtectedRoute;
