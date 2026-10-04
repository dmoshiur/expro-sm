import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useAuth } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppLayout } from '@/components/AppLayout';
import Login from '@/pages/admin/Login';
import Dashboard from '@/pages/admin/Dashboard';
import InvestorsList from '@/pages/admin/InvestorsList';
import InvestorDetail from '@/pages/admin/InvestorDetail';
import InvestmentsList from '@/pages/admin/InvestmentsList';
import InvestmentNew from '@/pages/admin/InvestmentNew';
import InvestmentDetail from '@/pages/admin/InvestmentDetail';
import PaymentsList from '@/pages/admin/PaymentsList';
import ReportsDue from '@/pages/admin/ReportsDue';
import ReportsCollections from '@/pages/admin/ReportsCollections';
import AuditLog from '@/pages/admin/AuditLog';
import Admins from '@/pages/admin/Admins';
import Settings from '@/pages/admin/Settings';
import Profile from '@/pages/admin/Profile';
import PayPage from '@/pages/public/PayPage';
import PayResultPage from '@/pages/public/PayResultPage';
import NotFound from '@/pages/NotFound';

export default function App() {
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const { status } = useAuth();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <Routes>
      {/* public */}
      <Route path="/pay/result" element={<PayResultPage />} />
      <Route path="/pay/:token" element={<PayPage />} />
      <Route path="/login" element={status === 'authenticated' ? <Navigate to="/" replace /> : <Login />} />

      {/* authenticated admin area */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/investors" element={<InvestorsList />} />
          <Route path="/investors/:id" element={<InvestorDetail />} />
          <Route path="/investments" element={<InvestmentsList />} />
          <Route path="/investments/new" element={<InvestmentNew />} />
          <Route path="/investments/:id" element={<InvestmentDetail />} />
          <Route path="/payments" element={<PaymentsList />} />
          <Route path="/reports/due" element={<ReportsDue />} />
          <Route path="/reports/collections" element={<ReportsCollections />} />
          <Route path="/profile" element={<Profile />} />

          {/* super admin only */}
          <Route element={<ProtectedRoute roles={['SUPER_ADMIN']} />}>
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/admins" element={<Admins />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
