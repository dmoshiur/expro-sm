import { z } from 'zod';

/**
 * Money entered in the UI is BDT; it is converted to integer poisha in the
 * service before it touches the database. Accepts "1,25,000.50" or 125000.5.
 */
export const bdtAmountSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.replace(/,/g, '').trim()))
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), 'Enter a valid amount (up to 2 decimal places)')
  .refine((value) => Number(value) > 0, 'Amount must be greater than zero')
  .refine((value) => Number(value) <= 1_000_000_000, 'Amount is unrealistically large');

export const intervalSchema = z.object({
  unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']),
  value: z.coerce.number().int().min(1).max(60),
});

export const createInvestmentSchema = z.object({
  investorId: z.string().uuid('Select an investor'),
  totalAmount: bdtAmountSchema,
  installmentCount: z.coerce.number().int().min(1, 'At least 1 installment').max(120, 'At most 120 installments'),
  firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  interval: intervalSchema.default({ unit: 'MONTH', value: 1 }),
  notes: z.string().trim().max(1000).optional(),
});

export const updateInvestmentSchema = z
  .object({
    notes: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Nothing to update');

/**
 * Bulk installment edit. The service validates that the new amounts still sum
 * to the investment total (and the database trigger enforces it again).
 */
export const updateInstallmentsSchema = z.object({
  installments: z
    .array(
      z.object({
        id: z.string().uuid(),
        amount: bdtAmountSchema.optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
      }),
    )
    .min(1, 'Nothing to update')
    .max(120),
});

export const installmentReasonSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required (it is stored in the audit log)').max(500),
});

export const listInvestmentsQuerySchema = z.object({
  investorId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  search: z.string().trim().max(120).optional(),
  onlyOverdue: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sortBy: z.enum(['createdAt', 'totalAmount', 'status']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const listInstallmentsQuerySchema = z.object({
  status: z.enum(['PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED']).optional(),
  statuses: z.string().trim().max(200).optional(),
  investorId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  overdueOnly: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const investmentIdParamSchema = z.object({ id: z.string().uuid('Invalid investment id') });
export const installmentIdParamSchema = z.object({ id: z.string().uuid('Invalid installment id') });

export type CreateInvestmentInput = z.infer<typeof createInvestmentSchema>;
export type UpdateInstallmentsInput = z.infer<typeof updateInstallmentsSchema>;
export type ListInvestmentsQuery = z.infer<typeof listInvestmentsQuerySchema>;
export type ListInstallmentsQuery = z.infer<typeof listInstallmentsQuerySchema>;
