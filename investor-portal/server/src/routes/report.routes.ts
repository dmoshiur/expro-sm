/** Dashboard + reports + exports. All roles may read; only writers may export. */
import { Router } from 'express';
import { z } from 'zod';
import * as reportController from '../controllers/report.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';

export const reportRouter = Router();

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD or an ISO timestamp')
  .optional();

const dueQuerySchema = z.object({
  from: isoDay,
  to: isoDay,
  status: z.enum(['PENDING', 'PARTIALLY_PAID', 'OVERDUE']).optional(),
  investorId: z.string().uuid().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const collectionQuerySchema = z.object({
  from: isoDay,
  to: isoDay,
  method: z.enum(['BKASH', 'CASH', 'BANK', 'OTHER']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

reportRouter.use(requireAuth);

/** GET /api/reports/due - due & overdue book */
reportRouter.get('/due', requirePermission('report:read'), validate({ query: dueQuerySchema }), asyncHandler(reportController.due));

/** GET /api/reports/collections - collection register */
reportRouter.get(
  '/collections',
  requirePermission('report:read'),
  validate({ query: collectionQuerySchema }),
  asyncHandler(reportController.collections),
);

/** GET /api/reports/investors/:id/statement - full account statement */
reportRouter.get(
  '/investors/:id/statement',
  requirePermission('report:read'),
  validate({ params: z.object({ id: z.string().uuid('Invalid investor id') }) }),
  asyncHandler(reportController.statement),
);

/** Excel (OOXML) exports */
reportRouter.get(
  '/due.xlsx',
  requirePermission('report:export'),
  validate({ query: dueQuerySchema }),
  asyncHandler(reportController.exportDueXlsx),
);
reportRouter.get(
  '/collections.xlsx',
  requirePermission('report:export'),
  validate({ query: collectionQuerySchema }),
  asyncHandler(reportController.exportCollectionsXlsx),
);
reportRouter.get(
  '/investors/:id/statement.xlsx',
  requirePermission('report:export'),
  validate({ params: z.object({ id: z.string().uuid('Invalid investor id') }) }),
  asyncHandler(reportController.exportStatementXlsx),
);
reportRouter.get(
  '/investors/:id/statement.pdf',
  requirePermission('report:export'),
  validate({ params: z.object({ id: z.string().uuid('Invalid investor id') }) }),
  asyncHandler(reportController.exportStatementPdf),
);

export default reportRouter;
