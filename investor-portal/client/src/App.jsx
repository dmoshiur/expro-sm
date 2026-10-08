import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { Layout } from './components/Layout.jsx';
import { ProtectedRoute } from './routes/ProtectedRoute.jsx';

import { Login } from './pages/admin/Login.jsx';
import { Dashboard } from './pages/admin/Dashboard.jsx';
import { InvestorsList } from './pages/admin/InvestorsList.jsx';
import { InvestorForm } from './pages/admin/InvestorForm.jsx';
import { InvestorDetail } from './pages/admin/InvestorDetail.jsx';
import { InvestmentsList } from './pages/admin/InvestmentsList.jsx';
import { InvestmentNew } from './pages/admin/InvestmentNew.jsx';
import { InvestmentDetail } from './pages/admin/InvestmentDetail.jsx';
import { InstallmentsList } from './pages/admin/InstallmentsList.jsx';
import { PaymentsList } from './pages/admin/PaymentsList.jsx';
import { ReportsCollections } from './pages/admin/ReportsCollections.jsx';
import { ReportsDue } from './pages/admin/ReportsDue.jsx';
import { Admins } from './pages/admin/Admins.jsx';
import { AuditLog } from './pages/admin/AuditLog.jsx';
import { SmsLog } from './pages/admin/SmsLog.jsx';
import { SystemStatus } from './pages/admin/SystemStatus.jsx';
import { Profile } from './pages/admin/Profile.jsx';
import { NotFound } from './pages/NotFound.jsx';

import { PayPage } from './pages/public/PayPage.jsx';
import { PayResultPage } from './pages/public/PayResultPage.jsx';

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          {/* Investor-facing (no session, token protected) */}
          <Route path="/pay/:token" element={<PayPage />} />
          <Route path="/pay/:token/result" element={<PayResultPage />} />
          <Route path="/pay/result" element={<PayResultPage />} />

          <Route path="/login" element={<Login />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/investors" element={<InvestorsList />} />
            <Route path="/investors/new" element={<ProtectedRoute minRole="ACCOUNTANT"><InvestorForm /></ProtectedRoute>} />
            <Route path="/investors/:id/edit" element={<ProtectedRoute minRole="ACCOUNTANT"><InvestorForm /></ProtectedRoute>} />
            <Route path="/investors/:id" element={<InvestorDetail />} />
            <Route path="/investments" element={<InvestmentsList />} />
            <Route path="/investments/new" element={<ProtectedRoute minRole="ACCOUNTANT"><InvestmentNew /></ProtectedRoute>} />
            <Route path="/investments/:id" element={<InvestmentDetail />} />
            <Route path="/installments" element={<InstallmentsList />} />
            <Route path="/payments" element={<PaymentsList />} />
            <Route path="/reports/collections" element={<ReportsCollections />} />
            <Route path="/reports/due" element={<ReportsDue />} />
            <Route path="/admins" element={<ProtectedRoute roles={['SUPER_ADMIN']}><Admins /></ProtectedRoute>} />
            <Route path="/audit" element={<ProtectedRoute roles={['SUPER_ADMIN']}><AuditLog /></ProtectedRoute>} />
            <Route path="/sms" element={<ProtectedRoute roles={['SUPER_ADMIN']}><SmsLog /></ProtectedRoute>} />
            <Route path="/system" element={<ProtectedRoute roles={['SUPER_ADMIN']}><SystemStatus /></ProtectedRoute>} />
            <Route path="/profile" element={<Profile />} />
          </Route>

          <Route path="/404" element={<NotFound />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
