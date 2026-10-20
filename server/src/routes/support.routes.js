/**
 * Admin support / inquiry routes. Reads: any signed-in admin.
 * Replies and status changes: SUPER_ADMIN + ACCOUNTANT.
 */
import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as ctrl from '../controllers/support.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/summary', asyncHandler(ctrl.summary));
router.get('/tickets', asyncHandler(ctrl.list));
router.get('/tickets/:id', asyncHandler(ctrl.detail));
router.post('/tickets/:id/messages', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.reply));
router.post('/tickets/:id/status', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.setStatus));

export default router;
