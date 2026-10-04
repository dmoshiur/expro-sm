/**
 * Permission matrix (enforced here AND documented in docs/permissions.md).
 *
 * SUPER_ADMIN : everything, incl. admins, audit log, settings, NID images.
 * ACCOUNTANT  : manage investments/installments, record manual payments,
 *               regenerate links, reports, view investors. NO nominee edits,
 *               NO admin management, NO NID.
 * VIEWER      : read-only dashboards + lists, masked sensitive fields.
 */
import type { AdminRole } from '@prisma/client';
import { forbidden } from '../utils/errors';

export type Permission =
  | 'admin:manage'
  | 'audit:read'
  | 'settings:write'
  | 'investor:read'
  | 'investor:write'
  | 'investor:nominee:write'
  | 'investor:sensitive:read' // NID value + image, unmasked mobile
  | 'investment:read'
  | 'investment:write'
  | 'installment:write'
  | 'installment:waive'
  | 'payment:read'
  | 'payment:manual'
  | 'paymentlink:send'
  | 'paymentlink:regenerate'
  | 'report:read'
  | 'report:export';

const SUPER_ADMIN: Permission[] = [
  'admin:manage',
  'audit:read',
  'settings:write',
  'investor:read',
  'investor:write',
  'investor:nominee:write',
  'investor:sensitive:read',
  'investment:read',
  'investment:write',
  'installment:write',
  'installment:waive',
  'payment:read',
  'payment:manual',
  'paymentlink:send',
  'paymentlink:regenerate',
  'report:read',
  'report:export',
];

const ACCOUNTANT: Permission[] = [
  'investor:read',
  'investor:write', // but NOT nominee:write, NOT sensitive:read
  'investment:read',
  'investment:write',
  'installment:write',
  'installment:waive',
  'payment:read',
  'payment:manual',
  'paymentlink:send',
  'paymentlink:regenerate',
  'report:read',
  'report:export',
];

const VIEWER: Permission[] = ['investor:read', 'investment:read', 'payment:read', 'report:read'];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN,
  ACCOUNTANT,
  VIEWER,
};

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function assertPermission(role: AdminRole, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw forbidden(`Your role (${role}) is not allowed to perform: ${permission}`);
  }
}

/** Roles allowed to see an unmasked mobile number / NID. */
export const canViewSensitive = (role: AdminRole): boolean => roleHasPermission(role, 'investor:sensitive:read');
