import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireAuth, requireRole, requireSuperAdmin } from '../middleware/auth.js';
import { photoUpload, scanUpload, ensureRawBody } from '../middleware/upload.js';
import * as ctrl from '../controllers/investor.controller.js';

const router = Router();
router.use(requireAuth);

// Reads: all roles (VIEWER gets masked PII inside the controllers).
router.get('/', asyncHandler(ctrl.list));
router.get('/:id', asyncHandler(ctrl.detail));

// Writes: investments/installments/reports are managed by SUPER_ADMIN + ACCOUNTANT.
router.post('/', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.create));
router.patch('/:id', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.update));
router.post('/:id/status', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.setStatus));
router.delete('/:id', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.remove));
router.post('/:id/restore', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.restore));

// Nominees and NID data: SUPER_ADMIN only.
router.post('/:id/nominees', requireSuperAdmin, asyncHandler(ctrl.replaceNominees));
router.patch('/:id/nominees/:nomineeId', requireSuperAdmin, asyncHandler(ctrl.updateNominee));
router.get('/:id/nid', requireSuperAdmin, asyncHandler(ctrl.revealNid));
router.get('/:id/nominees/:nomineeId/nid', requireSuperAdmin, asyncHandler(ctrl.revealNomineeNid));

// Files
router.get('/:id/photo', asyncHandler(ctrl.getPhoto));
router.post('/:id/photo', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), photoUpload, ensureRawBody, asyncHandler(ctrl.uploadPhoto));
router.get('/:id/nid-scan', requireSuperAdmin, asyncHandler(ctrl.getNidScan));
router.post('/:id/nid-scan', requireSuperAdmin, scanUpload, ensureRawBody, asyncHandler(ctrl.uploadNidScan));

export default router;
