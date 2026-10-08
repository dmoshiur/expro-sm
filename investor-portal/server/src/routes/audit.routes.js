import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/audit.controller.js';

const router = Router();
// The audit trail is SUPER_ADMIN only (docs/permissions.md).
router.use(requireAuth, requireSuperAdmin);
router.get('/', asyncHandler(ctrl.list));
router.get('/filters', asyncHandler(ctrl.filters));

export default router;
