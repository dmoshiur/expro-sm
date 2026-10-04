/**
 * API router. Feature routers are mounted here as the phases land:
 *   /api/auth        authentication + 2FA                (phase 1)
 *   /api/admins      admin management (SUPER_ADMIN)      (phase 1)
 *   /api/investors   investors + nominees                (phase 2)
 *   /api/investments investments + installments          (phase 3)
 *   /api/payments    payment links, manual entry, exports (phase 4/5/6)
 *   /api/dashboard   dashboard + reports + audit log     (phase 6)
 *   /api/public      tokenised public payment pages      (phase 4)
 */
import { Router } from 'express';
import { prisma } from '../config/prisma';
import { asyncHandler } from '../utils/asyncHandler';
import { authRouter } from './auth.routes';
import { adminRouter } from './admin.routes';
import { investorRouter } from './investor.routes';
import { auditRouter } from './audit.routes';
import { investmentRouter, installmentRouter } from './investment.routes';
import { paymentRouter } from './payment.routes';
import { publicRouter } from './public.routes';
import { fileRouter } from './file.routes';
import { dashboardRouter } from './dashboard.routes';
import { reportRouter } from './report.routes';
import { settingsRouter } from './settings.routes';

export const apiRouter = Router();

// feature routers
apiRouter.use('/auth', authRouter);
apiRouter.use('/admins', adminRouter);
apiRouter.use('/investors', investorRouter);
apiRouter.use('/investments', investmentRouter);
apiRouter.use('/installments', installmentRouter);
apiRouter.use('/payments', paymentRouter);
apiRouter.use('/public', publicRouter);
apiRouter.use('/audit-logs', auditRouter);
apiRouter.use('/files', fileRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/reports', reportRouter);
apiRouter.use('/settings', settingsRouter);

/** Liveness + database readiness probe. */
apiRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      database: 'up',
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    });
  }),
);

export default apiRouter;
