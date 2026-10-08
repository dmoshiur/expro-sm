import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth } from '../middleware/auth.js';
import * as ctrl from '../controllers/dashboard.controller.js';

const router = Router();
router.use(requireAuth);
router.get('/', asyncHandler(ctrl.summary));

export default router;
