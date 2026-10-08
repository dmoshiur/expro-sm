import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, loginIpLimiter } from '../middleware/security.js';
import * as auth from '../controllers/auth.controller.js';

const router = Router();

router.post('/login', loginIpLimiter, loginLimiter, asyncHandler(auth.login));
router.post('/logout', asyncHandler(auth.logout));
router.get('/me', requireAuth, asyncHandler(auth.me));
router.post('/refresh', requireAuth, asyncHandler(auth.refresh));
router.post('/change-password', requireAuth, asyncHandler(auth.changePassword));
router.get('/totp', requireAuth, asyncHandler(auth.totpStatus));
router.post('/totp/setup', requireAuth, asyncHandler(auth.totpSetup));
router.post('/totp/confirm', requireAuth, asyncHandler(auth.totpConfirm));
router.post('/totp/disable', requireAuth, asyncHandler(auth.totpDisable));
router.post('/sessions/revoke-others', requireAuth, asyncHandler(auth.revokeOtherSessions));

export default router;
