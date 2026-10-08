import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { payLimiter, payStartLimiter } from '../middleware/security.js';
import * as ctrl from '../controllers/public.controller.js';

/** Mounted at /api/public - no authentication, token + rate limit only. */
const router = Router();

router.get('/pay/:token', payLimiter, asyncHandler(ctrl.viewLink));
router.post('/pay/:token/start', payLimiter, payStartLimiter, asyncHandler(ctrl.startPayment));
router.post('/pay/:token/verify', payLimiter, asyncHandler(ctrl.verifyPayment));

export default router;

/** Mounted at /pay (root) - the gateway redirect target. */
export const payCallbackRouter = Router();
payCallbackRouter.get('/callback', payLimiter, asyncHandler(ctrl.gatewayCallback));
payCallbackRouter.get('/result', asyncHandler(ctrl.resultFallback));
