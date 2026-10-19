import { Navigate, useLocation } from 'react-router-dom';
import { useInvestorAuth } from '../context/InvestorAuthContext.jsx';
import { Spinner } from '../components/ui.jsx';

/**
 * Investor portal route guard. The server enforces everything (401 without a
 * session, 403 PASSWORD_CHANGE_REQUIRED until the temporary password is
 * replaced); this only keeps the UI on the right screen.
 */
export function InvestorProtectedRoute({ children }) {
  const { investor, loading, mustChangePassword } = useInvestorAuth();
  const location = useLocation();

  if (loading) return <Spinner label="Checking your session…" />;
  if (!investor) return <Navigate to="/portal/login" replace state={{ from: location.pathname }} />;
  if (mustChangePassword && location.pathname !== '/portal/account') {
    return <Navigate to="/portal/account" replace state={{ firstLogin: true }} />;
  }
  return children;
}
