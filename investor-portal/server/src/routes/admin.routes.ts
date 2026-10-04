import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import { currentAdmin, requireAuth, requirePermission } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { sensitiveLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import {
  adminIdParamSchema,
  createAdminSchema,
  listAdminsQuerySchema,
  resetAdminPasswordSchema,
  updateAdminSchema,
} from '../validators/auth.validator';
import { asyncHandler } from '../utils/asyncHandler';

export const adminRouter = Router();

// Everything in this router is SUPER_ADMIN only (admin:manage permission).
adminRouter.use(requireAuth, csrfProtection, requirePermission('admin:manage'));

/** GET /api/admins/me/permissions - what the UI may show for the current role */
adminRouter.get('/me/permissions', (req, res) => {
  const admin = currentAdmin(req);
  res.json({ role: admin.role });
});

adminRouter.get('/', validate({ query: listAdminsQuerySchema }), asyncHandler(adminController.listAdmins));
adminRouter.post('/', validate({ body: createAdminSchema }), asyncHandler(adminController.createAdmin));

adminRouter.patch(
  '/:id',
  validate({ params: adminIdParamSchema, body: updateAdminSchema }),
  asyncHandler(adminController.updateAdmin),
);

adminRouter.post(
  '/:id/reset-password',
  sensitiveLimiter,
  validate({ params: adminIdParamSchema, body: resetAdminPasswordSchema }),
  asyncHandler(adminController.resetAdminPassword),
);

adminRouter.post(
  '/:id/reset-2fa',
  sensitiveLimiter,
  validate({ params: adminIdParamSchema }),
  asyncHandler(adminController.resetAdminTwoFactor),
);

adminRouter.post(
  '/:id/unlock',
  validate({ params: adminIdParamSchema }),
  asyncHandler(adminController.unlockAdmin),
);

export default adminRouter;
