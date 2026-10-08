import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as ctrl from '../controllers/payment.controller.js';

const router = Router();

// Webhook sits outside the session guard (it is a machine-to-machine call and is
// disabled by default). See PAYMENTS_WEBHOOK_ENABLED.
router.post('/webhook', asyncHandler(ctrl.webhook));

router.use(requireAuth);

router.get('/', asyncHandler(ctrl.list));
router.get('/provider', asyncHandler(ctrl.providerInfo));
router.get('/export', asyncHandler(ctrl.exportCsv));
router.post('/manual', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.recordManual));
router.get('/:id', asyncHandler(ctrl.detail));
router.get('/:id/receipt', asyncHandler(ctrl.receipt));
router.get('/:id/receipt.json', asyncHandler(ctrl.receiptJson));
router.post('/:id/refresh', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.refresh));
router.post('/:id/cancel', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.cancel));

export default router;
