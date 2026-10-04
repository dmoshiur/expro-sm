import { Router } from 'express';
import * as investorController from '../controllers/investor.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { sensitiveLimiter } from '../middleware/rateLimit';
import { optionalFile } from '../middleware/upload';
import { validate } from '../middleware/validate';
import {
  createInvestorSchema,
  investorIdParamSchema,
  listInvestorsQuerySchema,
  setNomineesSchema,
  updateInvestorSchema,
} from '../validators/investor.validator';
import { asyncHandler } from '../utils/asyncHandler';

export const investorRouter = Router();

investorRouter.use(requireAuth, csrfProtection);

// ----------------------------- reads ---------------------------------------
investorRouter.get(
  '/',
  requirePermission('investor:read'),
  validate({ query: listInvestorsQuerySchema }),
  asyncHandler(investorController.list),
);

investorRouter.get(
  '/:id',
  requirePermission('investor:read'),
  validate({ params: investorIdParamSchema }),
  asyncHandler(investorController.detail),
);

// ----------------------------- writes --------------------------------------
investorRouter.post(
  '/',
  requirePermission('investor:write'),
  validate({ body: createInvestorSchema }),
  asyncHandler(investorController.create),
);

investorRouter.patch(
  '/:id',
  requirePermission('investor:write'),
  validate({ params: investorIdParamSchema, body: updateInvestorSchema }),
  asyncHandler(investorController.update),
);

/** Nominee management is restricted to SUPER_ADMIN (service re-checks). */
investorRouter.put(
  '/:id/nominees',
  requirePermission('investor:nominee:write'),
  validate({ params: investorIdParamSchema, body: setNomineesSchema }),
  asyncHandler(investorController.setNominees),
);

investorRouter.post(
  '/:id/deactivate',
  requirePermission('investor:write'),
  validate({ params: investorIdParamSchema }),
  asyncHandler(investorController.deactivate),
);

investorRouter.post(
  '/:id/reactivate',
  requirePermission('investor:write'),
  validate({ params: investorIdParamSchema }),
  asyncHandler(investorController.reactivate),
);

// ----------------------------- files ---------------------------------------
investorRouter.post(
  '/:id/photo',
  requirePermission('investor:write'),
  sensitiveLimiter,
  optionalFile('photo'),
  validate({ params: investorIdParamSchema }),
  asyncHandler(investorController.uploadPhoto),
);

investorRouter.post(
  '/:id/nid-scan',
  requirePermission('investor:sensitive:read'),
  sensitiveLimiter,
  optionalFile('nidScan'),
  validate({ params: investorIdParamSchema }),
  asyncHandler(investorController.uploadNidScan),
);

investorRouter.get(
  '/:id/nid-scan-url',
  requirePermission('investor:sensitive:read'),
  sensitiveLimiter,
  validate({ params: investorIdParamSchema }),
  asyncHandler(investorController.nidScanUrl),
);

export default investorRouter;
