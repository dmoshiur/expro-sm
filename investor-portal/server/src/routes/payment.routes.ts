import { Router } from 'express';
import { z } from 'zod';
import * as paymentLinkController from '../controllers/paymentLink.controller';
import * as paymentController from '../controllers/payment.controller';
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

/** Record a cash / bank / other manual payment (ACCOUNTANT and above). */
paymentRouter.post(
  '/installments/:id/manual',
  requirePermission('payment:manual'),
  validate({
    params: installmentParam,
    body: z.object({
      amount: z.union([z.string(), z.number()]).optional(),
      method: z.enum(['CASH', 'BANK', 'OTHER']),
      reference: z.string().trim().min(3, 'A reference is required').max(120),
      note: z.string().trim().max(500).optional(),
      paidAt: z.string().datetime().optional(),
    }),
  }),
  asyncHandler(paymentController.recordManual),
);

/** Payment list with filters (status, method, gateway, investor, dates, search). */
paymentRouter.get(
  '/',
  requirePermission('payment:read'),
  validate({
    query: z.object({
      status: z.enum(['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED']).optional(),
      method: z.enum(['BKASH', 'CASH', 'BANK', 'OTHER']).optional(),
      gateway: z.enum(['BKASH', 'NAGAD', 'MANUAL']).optional(),
      investorId: z.string().uuid().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      search: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(paymentController.list),
);

paymentRouter.get(
  '/:id/receipt.pdf',
  requirePermission('payment:read'),
  validate({ params: z.object({ id: z.string().uuid('Invalid payment id') }) }),
  asyncHandler(paymentController.downloadReceipt),
);

paymentRouter.get(
  '/:id',
  requirePermission('payment:read'),
  validate({ params: z.object({ id: z.string().uuid('Invalid payment id') }) }),
  asyncHandler(paymentController.detail),
);

export default paymentRouter;
