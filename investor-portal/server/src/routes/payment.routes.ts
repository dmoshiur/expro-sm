import { Router } from 'express';
import { z } from 'zod';
import * as paymentLinkController from '../controllers/paymentLink.controller';
import { requireAuth, requirePermission } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { sensitiveLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';

export const paymentRouter = Router();

const installmentParam = z.object({ id: z.string().uuid('Invalid installment id') });
const investmentParam = z.object({ id: z.string().uuid('Invalid investment id') });

const smsLogQuerySchema = z.object({
  investorId: z.string().uuid().optional(),
  installmentId: z.string().uuid().optional(),
  status: z.enum(['QUEUED', 'SENT', 'FAILED']).optional(),
  purpose: z.enum(['PAYMENT_LINK', 'REMINDER_DUE', 'REMINDER_OVERDUE', 'MANUAL', 'BULK']).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

paymentRouter.use(requireAuth, csrfProtection);

/** Regenerate the payment link (invalidates the previous one). */
paymentRouter.post(
  '/installments/:id/link/regenerate',
  requirePermission('paymentlink:regenerate'),
  sensitiveLimiter,
  validate({ params: installmentParam, body: z.object({ sendSms: z.boolean().optional() }).default({}) }),
  asyncHandler(paymentLinkController.regenerate),
);

/** Send the (current or new) payment link by SMS. */
paymentRouter.post(
  '/installments/:id/link/send',
  requirePermission('paymentlink:send'),
  sensitiveLimiter,
  validate({ params: installmentParam }),
  asyncHandler(paymentLinkController.sendLink),
);

/** Bulk send for all open installments of an investment. */
paymentRouter.post(
  '/investments/:id/links/send',
  requirePermission('paymentlink:send'),
  sensitiveLimiter,
  validate({ params: investmentParam }),
  asyncHandler(paymentLinkController.sendBulk),
);

/** SMS delivery log (this is how admins verify a link really went out). */
paymentRouter.get(
  '/sms-logs',
  requirePermission('payment:read'),
  validate({ query: smsLogQuerySchema }),
  asyncHandler(paymentLinkController.listSmsLogs),
);

export default paymentRouter;
