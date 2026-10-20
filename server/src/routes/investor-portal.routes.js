/**
 * Investor self-service portal (mounted at /api/portal).
 *
 * Authentication is the investor session cookie only - admin sessions mean
 * nothing here. After login, a temporary (admin-issued) password locks the
 * account to the auth endpoints until it is changed.
 */
import { Router } from 'express';
import { asyncHandler } from '../utils/async.js';
import { requireInvestorAuth, requirePasswordChanged } from '../middleware/investor-auth.js';
import { investorLoginLimiter, investorLoginIpLimiter, payStartLimiter } from '../middleware/security.js';
import * as ctrl from '../controllers/investor-portal.controller.js';
import * as donationCtrl from '../controllers/donation.controller.js';

const router = Router();

router.post('/auth/login', investorLoginIpLimiter, investorLoginLimiter, asyncHandler(ctrl.login));
router.post('/auth/logout', asyncHandler(ctrl.logout));

router.use(requireInvestorAuth);
router.get('/auth/me', asyncHandler(ctrl.me));
router.post('/auth/change-password', asyncHandler(ctrl.changePassword));
router.post('/auth/sessions/revoke-others', asyncHandler(ctrl.revokeOtherSessions));

// Everything below requires the temporary password to have been replaced.
router.use(requirePasswordChanged);

router.get('/dashboard', asyncHandler(ctrl.dashboard));
router.get('/profile', asyncHandler(ctrl.profile));
router.patch('/profile', asyncHandler(ctrl.updateProfile));
router.get('/investments', asyncHandler(ctrl.investments));
router.get('/installments', asyncHandler(ctrl.installments));
router.get('/payments', asyncHandler(ctrl.payments));
router.post('/installments/:id/pay-link', payStartLimiter, asyncHandler(ctrl.payLink));
router.get('/payments/:id/receipt', asyncHandler(ctrl.receipt));
router.get('/statement.csv', asyncHandler(ctrl.statementCsv));
router.get('/statement.html', asyncHandler(ctrl.statementHtml));
router.get('/certificate', asyncHandler(ctrl.certificate));

// Wallet: balance, ledger and self-service deposit / withdrawal requests.
router.get('/wallet', asyncHandler(ctrl.wallet));
router.post('/wallet/requests', payStartLimiter, asyncHandler(ctrl.requestWalletTransaction));

// Document slots (photo, NID front/back, signature) + nominee photos.
// Read-only for investors: uploads are done by the office (see investor-portal.service IDENTITY_LOCKED_FIELDS).
router.get('/documents', asyncHandler(ctrl.documents));
router.get('/documents/:kind/file', asyncHandler(ctrl.ownDocumentFile));
router.get('/nominees/:nomineeId/photo', asyncHandler(ctrl.ownNomineePhotoFile));

// Support / inquiries.
router.get('/support/tickets', asyncHandler(ctrl.supportTickets));
router.post('/support/tickets', asyncHandler(ctrl.createSupportTicket));
router.get('/support/tickets/:id', asyncHandler(ctrl.supportTicket));
router.post('/support/tickets/:id/messages', asyncHandler(ctrl.replySupportTicket));
router.post('/support/tickets/:id/close', asyncHandler(ctrl.closeSupportTicket));

router.get('/photo', asyncHandler(ctrl.getPhoto));
router.get('/nid-scan', asyncHandler(ctrl.getNidScan));

// Donates: fund overview + own history, start a gateway payment, verify, receipt.
router.get('/donations', asyncHandler(donationCtrl.overview));
router.post('/donations', payStartLimiter, asyncHandler(donationCtrl.create));
router.get('/donations/:id', asyncHandler(donationCtrl.detail));
router.post('/donations/:id/verify', payStartLimiter, asyncHandler(donationCtrl.verify));
router.get('/donations/:id/receipt', asyncHandler(donationCtrl.receipt));

export default router;
