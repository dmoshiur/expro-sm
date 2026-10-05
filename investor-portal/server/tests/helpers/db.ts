/**
 * Test database helpers.
 *
 * Everything runs against TEST_DATABASE_URL - a throwaway libSQL/SQLite
 * database (`file:./prisma/test.db` by default) that `npm test` re-creates by
 * dropping every table and re-applying prisma/migrations. Between tests we
 * delete the business rows so each test starts from a known state.
 *
 * PostgreSQL had `TRUNCATE ... CASCADE`, which bypasses row triggers and
 * re-checks nothing. SQLite has no TRUNCATE, so:
 *   - rows are deleted child-first (foreign keys stay satisfied), and
 *   - the append-only trigger on audit_logs is dropped for the wipe and put
 *     back exactly as prisma/migrations/20260101000000_init/migration.sql
 *     defines it, so the trigger itself stays under test.
 */
import argon2 from 'argon2';
import type { AdminRole } from '../../src/generated/prisma/client';
import { prisma } from '../../src/config/prisma';

/** Child tables first: foreign keys are enforced (PRAGMA foreign_keys = ON). */
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

/** Kept in sync with the init migration (see the "audit_logs is append-only" block). */
const AUDIT_APPEND_ONLY_TRIGGERS = [
  `CREATE TRIGGER "audit_logs_no_update" BEFORE UPDATE ON "audit_logs"
   BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only (UPDATE is not permitted)'); END`,
  `CREATE TRIGGER "audit_logs_no_delete" BEFORE DELETE ON "audit_logs"
   BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only (DELETE is not permitted)'); END`,
];

async function dropAuditGuards(): Promise<void> {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "audit_logs_no_update"');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "audit_logs_no_delete"');
}

async function restoreAuditGuards(): Promise<void> {
  await dropAuditGuards();
  for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
    await prisma.$executeRawUnsafe(trigger);
  }
}

export async function truncateAll(): Promise<void> {
  await dropAuditGuards();
  try {
    for (const table of TABLES) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
  } finally {
    await restoreAuditGuards();
  }
}

export { restoreAuditGuards };

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
