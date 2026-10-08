import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/admin.controller.js';

const router = Router();

// Admin management is SUPER_ADMIN only (see docs/permissions.md).
router.use(requireAuth, requireSuperAdmin);

router.get('/', asyncHandler(ctrl.list));
router.post('/', asyncHandler(ctrl.create));
router.get('/:id', asyncHandler(ctrl.detail));
router.patch('/:id', asyncHandler(ctrl.update));
router.post('/:id/reset-password', asyncHandler(ctrl.resetPassword));
router.post('/:id/reset-totp', asyncHandler(ctrl.resetTotp));
router.post('/:id/revoke-sessions', asyncHandler(ctrl.revokeSessions));

export default router;
