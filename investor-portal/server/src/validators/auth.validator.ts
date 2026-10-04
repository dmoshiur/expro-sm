import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'Email is required')
  .max(160)
  .email('Enter a valid email address');

/**
 * Password policy: at least 10 characters, one letter and one digit and no
 * leading/trailing whitespace. Long passphrases are welcome (max 200).
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number')
  .refine((value) => value === value.trim(), 'Password must not start or end with a space');

export const totpSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, 'Enter the 6 digit code from your authenticator app');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(200),
  totp: z.string().trim().regex(/^[0-9]{6}$/).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const twoFactorVerifySchema = z.object({ code: totpSchema });

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: totpSchema.optional(),
});

export const refreshSchema = z.object({});

export type LoginBody = z.infer<typeof loginSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

// ------------------------------- admins ------------------------------------

export const adminRoleSchema = z.enum(['SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER']);

export const createAdminSchema = z.object({
  name: z.string().trim().min(3, 'Name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
  role: adminRoleSchema,
});

export const updateAdminSchema = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    role: adminRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Nothing to update');

export const adminIdParamSchema = z.object({ id: z.string().uuid('Invalid admin id') });

export const resetAdminPasswordSchema = z.object({
  newPassword: passwordSchema,
});

export const listAdminsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: adminRoleSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
