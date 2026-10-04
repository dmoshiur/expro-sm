import { Router } from 'express';
import { z } from 'zod';
import * as settingsController from '../controllers/settings.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';

export const settingsRouter = Router();

settingsRouter.use(requireAuth, csrfProtection, requirePermission('settings:write'));

settingsRouter.get('/', asyncHandler(settingsController.list));
settingsRouter.put(
  '/',
  validate({ body: z.record(z.union([z.string(), z.number()])) }),
  asyncHandler(settingsController.update),
);

export default settingsRouter;
