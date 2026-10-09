import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import * as ctrl from '../controllers/installment.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(ctrl.list));
router.post('/bulk/send-links', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), rateLimit({ name: 'bulk-sms', windowMs: 60_000, max: 3 }), asyncHandler(ctrl.bulkSendLinks));
router.get('/:id', asyncHandler(ctrl.detail));
router.patch('/:id', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.update));
router.post('/:id/state', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.setState));
router.post('/:id/pay-link', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.issuePayLink));
router.post('/:id/pay-link/regenerate', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.issuePayLink));
router.post('/:id/send-link', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), rateLimit({ name: 'sms-link', windowMs: 60_000, max: 20 }), asyncHandler(ctrl.sendLink));

export default router;
