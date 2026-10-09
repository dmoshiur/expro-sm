import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, ROLE_RANK } from '../context/AuthContext.jsx';
import { Spinner } from '../components/ui.jsx';

/**
 * Route guard. `roles` limits by exact role; `minRole` uses the role ladder
 * (VIEWER < ACCOUNTANT < SUPER_ADMIN). Server-side RBAC is authoritative - this
 * only keeps the UI honest.
 */
export function ProtectedRoute({ children, roles, minRole }) {
  const { admin, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner label="Checking your session…" />;
  if (!admin) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  if (roles && !roles.includes(admin.role)) {
    return (
      <div className="alert error">
        You do not have permission to view this page ({admin.role}). Ask a Super Admin if you need access.
      </div>
    );
  }
  if (minRole && ROLE_RANK[admin.role] < ROLE_RANK[minRole]) {
    return <div className="alert error">Your role ({admin.role}) is not sufficient for this page.</div>;
  }
  return children;
}
