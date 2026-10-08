/**
 * Route tree.
 *   /api/health            - liveness (no auth)
 *   /api/auth              - login, 2FA, sessions
 *   /api/admins            - SUPER_ADMIN only
 *   /api/investors         - investors + nominees + files
 *   /api/investments       - investments + installments
 *   /api/installments      - installment level operations
 *   /api/payments          - payments, manual entries, receipts
 *   /api/public            - investor-facing (token protected, no session)
 *   /api/dashboard         - KPIs
 *   /api/reports           - reports + CSV exports
 *   /api/audit             - audit log (SUPER_ADMIN)
 *   /api/sms               - SMS log + test send
 *   /api/jobs              - job status/run (SUPER_ADMIN)
 */
import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import investorRoutes from './investor.routes.js';
import investmentRoutes from './investment.routes.js';
import installmentRoutes from './installment.routes.js';
import paymentRoutes from './payment.routes.js';
import publicRoutes from './public.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import reportRoutes from './report.routes.js';
import auditRoutes from './audit.routes.js';
import smsRoutes from './sms.routes.js';
import jobRoutes from './job.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/admins', adminRoutes);
router.use('/investors', investorRoutes);
router.use('/investments', investmentRoutes);
router.use('/installments', installmentRoutes);
router.use('/payments', paymentRoutes);
router.use('/public', publicRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/reports', reportRoutes);
router.use('/audit', auditRoutes);
router.use('/sms', smsRoutes);
router.use('/jobs', jobRoutes);

export default router;
