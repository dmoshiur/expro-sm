import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth } from '../middleware/auth.js';
import * as ctrl from '../controllers/donation.controller.js';

/** Mounted at /api/donations - staff, read-only ledger of donations. */
const router = Router();

router.use(requireAuth);
router.get('/', asyncHandler(ctrl.list));

export default router;
