import { z } from 'zod';

/** Bangladeshi mobile numbers: 01XXXXXXXXX (11 digits) or +8801XXXXXXXXX. */
export const bdMobileSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => /^(\+?880|0)1[3-9]\d{8}$/.test(value), 'Enter a valid Bangladeshi mobile number (e.g. 01712345678)')
  .transform((value) => (value.startsWith('+880') ? `0${value.slice(4)}` : value.startsWith('880') ? `0${value.slice(3)}` : value));

export const nidSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => /^\d{10}$|^\d{13}$|^\d{17}$/.test(value), 'NID must be 10, 13 or 17 digits');

export const nomineeSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(3, 'Nominee name is required').max(120),
  relation: z.string().trim().min(2, 'Relation is required').max(60),
  mobile: bdMobileSchema,
  nid: nidSchema.optional().or(z.literal('').transform(() => undefined)),
  sharePercent: z.coerce.number().int().min(1, 'Minimum 1%').max(100, 'Maximum 100%'),
});

export const createInvestorSchema = z.object({
  name: z.string().trim().min(3, 'Name is required').max(160),
  mobile: bdMobileSchema,
  nid: nidSchema.optional().or(z.literal('').transform(() => undefined)),
  address: z.string().trim().max(400).optional(),
  notes: z.string().trim().max(1000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  nominees: z
    .array(nomineeSchema)
    .max(3, 'An investor can have at most 3 nominees')
    .default([])
    .refine(
      (nominees) => nominees.length === 0 || nominees.reduce((sum, nominee) => sum + nominee.sharePercent, 0) === 100,
      'Nominee shares must add up to exactly 100%',
    ),
});

export const updateInvestorSchema = z
  .object({
    name: z.string().trim().min(3).max(160).optional(),
    mobile: bdMobileSchema.optional(),
    nid: nidSchema.optional(),
    address: z.string().trim().max(400).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Nothing to update');

/** Nominee changes are a separate, SUPER_ADMIN-only operation. */
export const setNomineesSchema = z.object({
  nominees: z
    .array(nomineeSchema)
    .max(3, 'An investor can have at most 3 nominees')
    .refine(
      (nominees) => nominees.length === 0 || nominees.reduce((sum, nominee) => sum + nominee.sharePercent, 0) === 100,
      'Nominee shares must add up to exactly 100%',
    ),
});

export const listInvestorsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  sortBy: z.enum(['createdAt', 'name', 'mobile', 'updatedAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const investorIdParamSchema = z.object({ id: z.string().uuid('Invalid investor id') });

export type CreateInvestorInput = z.infer<typeof createInvestorSchema>;
export type UpdateInvestorInput = z.infer<typeof updateInvestorSchema>;
export type NomineeInput = z.infer<typeof nomineeSchema>;
export type ListInvestorsQuery = z.infer<typeof listInvestorsQuerySchema>;
