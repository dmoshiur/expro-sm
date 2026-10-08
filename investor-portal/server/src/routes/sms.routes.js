import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import * as ctrl from '../controllers/sms.controller.js';

const router = Router();
router.use(requireAuth);
router.get('/', asyncHandler(ctrl.list));
router.get('/provider', asyncHandler(ctrl.providerInfo));
router.post('/test', requireSuperAdmin, rateLimit({ name: 'sms-test', windowMs: 60_000, max: 5 }), asyncHandler(ctrl.sendTest));

export default router;
