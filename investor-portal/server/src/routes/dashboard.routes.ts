/** Dashboard summary + chart series. */
import { Router } from 'express';
import { z } from 'zod';
import * as reportController from '../controllers/report.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

/** GET /api/dashboard - KPI summary, collection trend and latest activity */
dashboardRouter.get(
  '/',
  requirePermission('report:read'),
  validate({ query: z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }) }),
  asyncHandler(reportController.summary),
);

export default dashboardRouter;
