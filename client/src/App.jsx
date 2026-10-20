import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { InvestorAuthProvider } from './context/InvestorAuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { Layout } from './components/Layout.jsx';
import { ProtectedRoute } from './routes/ProtectedRoute.jsx';
import { InvestorProtectedRoute } from './routes/InvestorProtectedRoute.jsx';

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
import { SupportInbox } from './pages/admin/SupportInbox.jsx';
import { NotFound } from './pages/NotFound.jsx';

import { PayPage } from './pages/public/PayPage.jsx';
import { PayResultPage } from './pages/public/PayResultPage.jsx';

import { PortalLogin } from './pages/portal/PortalLogin.jsx';
import { PortalLayout } from './pages/portal/PortalLayout.jsx';
import { PortalDashboard } from './pages/portal/PortalDashboard.jsx';
import { PortalProfile } from './pages/portal/PortalProfile.jsx';
import { PortalInvestments } from './pages/portal/PortalInvestments.jsx';
import { PortalInstallments } from './pages/portal/PortalInstallments.jsx';
import { PortalPayments } from './pages/portal/PortalPayments.jsx';
import { PortalAccount } from './pages/portal/PortalAccount.jsx';
import { PortalWallet } from './pages/portal/PortalWallet.jsx';
import { PortalSupport } from './pages/portal/PortalSupport.jsx';
import { PortalDigitalId } from './pages/portal/PortalDigitalId.jsx';
import { PortalPaymentHub } from './pages/portal/PortalPaymentHub.jsx';
import { PortalDonates, PortalDonateResult } from './pages/portal/PortalDonates.jsx';
import { PortalMyTeam, PortalAccountTransfers, PortalPolicy } from './pages/portal/PortalPlaceholders.jsx';
import { DonationsList } from './pages/admin/DonationsList.jsx';

/** Investor portal subtree gets its own auth provider (separate session). */
function PortalShell() {
  return (
    <InvestorAuthProvider>
      <Outlet />
    </InvestorAuthProvider>
  );
}

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

          {/* Investor self-service portal (investor session, own data only) */}
          <Route element={<PortalShell />}>
            <Route path="/portal/login" element={<PortalLogin />} />
            <Route
              element={
                <InvestorProtectedRoute>
                  <PortalLayout />
                </InvestorProtectedRoute>
              }
            >
              <Route path="/portal" element={<PortalDashboard />} />
              <Route path="/portal/profile" element={<PortalProfile />} />
              <Route path="/portal/investments" element={<PortalInvestments />} />
              <Route path="/portal/installments" element={<PortalInstallments />} />
              <Route path="/portal/payments" element={<PortalPayments />} />
              <Route path="/portal/wallet" element={<PortalWallet />} />
              <Route path="/portal/support" element={<PortalSupport />} />
              <Route path="/portal/account" element={<PortalAccount />} />
              <Route path="/portal/digital-id" element={<PortalDigitalId />} />
              <Route path="/portal/payment" element={<PortalPaymentHub />} />
              <Route path="/portal/donates" element={<PortalDonates />} />
              <Route path="/portal/donates/result" element={<PortalDonateResult />} />
              <Route path="/portal/team" element={<PortalMyTeam />} />
              <Route path="/portal/transfers" element={<PortalAccountTransfers />} />
              <Route path="/portal/privacy" element={<PortalPolicy kind="privacy" />} />
              <Route path="/portal/terms" element={<PortalPolicy kind="terms" />} />
              <Route path="/portal/nominees" element={<Navigate to="/portal/profile?tab=nominees" replace />} />
            </Route>
          </Route>

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
            <Route path="/donations" element={<DonationsList />} />
            <Route path="/payments" element={<PaymentsList />} />
            <Route path="/reports/collections" element={<ReportsCollections />} />
            <Route path="/reports/due" element={<ReportsDue />} />
            <Route path="/support" element={<SupportInbox />} />
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
