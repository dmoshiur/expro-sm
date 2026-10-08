import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as ctrl from '../controllers/investment.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(ctrl.list));
router.get('/schedule-preview', asyncHandler(ctrl.schedulePreview));
router.post('/', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.create));
router.get('/:id', asyncHandler(ctrl.detail));
router.get('/:id/installments', asyncHandler(ctrl.listInstallments));
router.patch('/:id/total', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.updateTotal));
router.post('/:id/status', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.setStatus));
router.post('/:id/resync', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.resync));

export default router;
