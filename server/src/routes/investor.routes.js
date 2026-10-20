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

// Investor portal access (self-service login) management.
router.get('/:id/portal-access', asyncHandler(ctrl.portalAccess));
router.post('/:id/portal-access/password', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.setPortalPassword));
router.post('/:id/portal-access/enabled', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.setPortalEnabled));
router.post('/:id/portal-access/revoke-sessions', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.revokePortalSessions));

// Nominees and NID data: SUPER_ADMIN only.
router.post('/:id/nominees', requireSuperAdmin, asyncHandler(ctrl.replaceNominees));
router.patch('/:id/nominees/:nomineeId', requireSuperAdmin, asyncHandler(ctrl.updateNominee));
router.get('/:id/nid', requireSuperAdmin, asyncHandler(ctrl.revealNid));
router.get('/:id/nominees/:nomineeId/nid', requireSuperAdmin, asyncHandler(ctrl.revealNomineeNid));

// Wallet: staff read the ledger, accountants post entries and decide requests.
router.get('/:id/wallet', asyncHandler(ctrl.wallet));
router.post('/:id/wallet/transactions', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.recordWalletEntry));
router.post('/:id/wallet/transactions/:txId/decide', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), asyncHandler(ctrl.decideWalletTransaction));

// Document slots + verification workflow.
router.get('/:id/documents', asyncHandler(ctrl.listDocuments));
router.post(
  '/:id/documents/:kind',
  requireRole('SUPER_ADMIN', 'ACCOUNTANT'),
  photoUpload,
  scanUpload,
  ensureRawBody,
  asyncHandler(ctrl.uploadDocument),
);
router.get('/:id/documents/:kind/file', asyncHandler(ctrl.documentFile));
router.post('/:id/documents/:kind/review', requireSuperAdmin, asyncHandler(ctrl.reviewDocument));
router.post('/:id/nominees/:nomineeId/photo', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), photoUpload, ensureRawBody, asyncHandler(ctrl.uploadNomineePhoto));
router.get('/:id/nominees/:nomineeId/photo', asyncHandler(ctrl.nomineePhotoFile));
router.post('/:id/nominees/:nomineeId/photo/review', requireSuperAdmin, asyncHandler(ctrl.reviewNomineePhoto));

// Membership approval + account freeze (Super Admin controls).
router.post('/:id/membership', requireSuperAdmin, asyncHandler(ctrl.decideMembership));
router.post('/:id/freeze', requireSuperAdmin, asyncHandler(ctrl.setFrozen));

// Files
router.get('/:id/photo', asyncHandler(ctrl.getPhoto));
router.post('/:id/photo', requireRole('SUPER_ADMIN', 'ACCOUNTANT'), photoUpload, ensureRawBody, asyncHandler(ctrl.uploadPhoto));
router.get('/:id/nid-scan', requireSuperAdmin, asyncHandler(ctrl.getNidScan));
router.post('/:id/nid-scan', requireSuperAdmin, scanUpload, ensureRawBody, asyncHandler(ctrl.uploadNidScan));

export default router;
