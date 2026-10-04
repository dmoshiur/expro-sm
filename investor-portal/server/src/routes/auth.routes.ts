import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { authLimiter, sensitiveLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import {
  changePasswordSchema,
  loginSchema,
  twoFactorDisableSchema,
  twoFactorVerifySchema,
} from '../validators/auth.validator';
import { asyncHandler } from '../utils/asyncHandler';

export const authRouter = Router();

// Brute-force protected: 10 attempts / 15 min / IP (+ per-account lockout).
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));
authRouter.post('/refresh', asyncHandler(authController.refresh));
authRouter.post('/logout', optionalAuth, asyncHandler(authController.logout));

authRouter.get('/me', requireAuth, asyncHandler(authController.me));
authRouter.post(
  '/change-password',
  requireAuth,
  sensitiveLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword),
);

authRouter.post('/2fa/setup', requireAuth, sensitiveLimiter, asyncHandler(authController.setupTwoFactor));
authRouter.post(
  '/2fa/verify',
  requireAuth,
  authLimiter,
  validate({ body: twoFactorVerifySchema }),
  asyncHandler(authController.verifyTwoFactor),
);
authRouter.post(
  '/2fa/disable',
  requireAuth,
  authLimiter,
  validate({ body: twoFactorDisableSchema }),
  asyncHandler(authController.disableTwoFactor),
);

export default authRouter;
