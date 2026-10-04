/**
 * API router. Feature routers are mounted here as the phases land:
 *   /api/auth        authentication + 2FA                (phase 1)
 *   /api/admins      admin management (SUPER_ADMIN)      (phase 1)
 *   /api/investors   investors + nominees                (phase 2)
 *   /api/investments investments + installments          (phase 3)
 *   /api/payments    payments, manual entry, exports     (phase 5/6)
 *   /api/dashboard   dashboard + reports + audit log     (phase 6)
 *   /api/public      tokenised public payment pages      (phase 4)
 */
import { Router } from 'express';
import { prisma } from '../config/prisma';
import { asyncHandler } from '../utils/asyncHandler';
import { authRouter } from './auth.routes';
import { adminRouter } from './admin.routes';

export const apiRouter = Router();

// feature routers
apiRouter.use('/auth', authRouter);
apiRouter.use('/admins', adminRouter);

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
