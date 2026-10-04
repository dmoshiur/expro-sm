import { Router } from 'express';
import * as publicController from '../controllers/public.controller';
import { publicPayLimiter } from '../middleware/rateLimit';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Unauthenticated router. Rate limited per IP; no cookies are used or set here,
 * so there is nothing for CSRF to abuse.
 */
export const publicRouter = Router();

publicRouter.get('/config', publicController.publicConfig);
publicRouter.get('/payments/:token', publicPayLimiter, asyncHandler(publicController.paymentDetails));

export default publicRouter;
