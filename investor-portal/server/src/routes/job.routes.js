import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/job.controller.js';

const router = Router();
router.use(requireAuth, requireSuperAdmin);
router.get('/', asyncHandler(ctrl.status));
router.post('/:name/run', asyncHandler(ctrl.run));

export default router;
