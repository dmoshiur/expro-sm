/**
 * Test database helpers.
 *
 * Everything runs against TEST_DATABASE_URL (investor_portal_test), which is
 * re-created by `npm test` before the suite starts. Between tests we truncate
 * the business tables so each test starts from a known state.
 */
import argon2 from 'argon2';
import type { AdminRole } from '@prisma/client';
import { prisma } from '../../src/config/prisma';

const TABLES = [
  'audit_logs',
  'sms_logs',
  'payments',
  'installments',
  'investments',
  'nominees',
  'investors',
  'refresh_tokens',
  'admins',
  'settings',
];

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
}

export const TEST_PASSWORD = 'TestPassw0rd!';

export async function createTestAdmin(options: {
  email?: string;
  name?: string;
  role?: AdminRole;
  password?: string;
  isActive?: boolean;
  twoFAEnabled?: boolean;
  twoFASecretEncrypted?: string | null;
  failedLoginCount?: number;
  lockedUntil?: Date | null;
} = {}) {
  return prisma.admin.create({
    data: {
      name: options.name ?? 'Test Admin',
      email: options.email ?? `admin-${Math.random().toString(36).slice(2, 10)}@test.local`,
      passwordHash: await argon2.hash(options.password ?? TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      }),
      role: options.role ?? 'SUPER_ADMIN',
      isActive: options.isActive ?? true,
      twoFAEnabled: options.twoFAEnabled ?? false,
      twoFASecret: options.twoFASecretEncrypted ?? null,
      failedLoginCount: options.failedLoginCount ?? 0,
      lockedUntil: options.lockedUntil ?? null,
    },
  });
}

export async function auditRows(action?: string) {
  return prisma.auditLog.findMany({
    where: action ? { action } : undefined,
    orderBy: { createdAt: 'asc' },
  });
}

export { prisma };
