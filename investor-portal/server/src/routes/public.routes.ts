import { Router } from 'express';
import { z } from 'zod';
import * as publicController from '../controllers/public.controller';
import { publicPayLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Unauthenticated router. Rate limited per IP; no cookies are used or set here,
 * so there is nothing for CSRF to abuse.
 */
export const publicRouter = Router();

publicRouter.get('/config', publicController.publicConfig);
publicRouter.get('/payments/:token', publicPayLimiter, asyncHandler(publicController.paymentDetails));

/** Starts a bKash session for a valid token. The amount comes from the DB. */
publicRouter.post(
  '/payments/:token/start',
  publicPayLimiter,
  validate({ params: z.object({ token: z.string().min(20).max(200) }) }),
  asyncHandler(publicController.startPayment),
);

/** Gateway return URL - never trusted on its own (see payment service). */
publicRouter.get(
  '/payments/bkash/callback',
  publicPayLimiter,
  asyncHandler(publicController.bkashCallback),
);

/** Optional webhook (BKASH_WEBHOOK_ENABLED=true). */
publicRouter.post('/payments/bkash/webhook', asyncHandler(publicController.bkashWebhook));

export default publicRouter;
