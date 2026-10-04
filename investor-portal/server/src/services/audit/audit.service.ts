/**
 * Audit trail service.
 *
 * Every create/update/delete/login/role change/payment/link regeneration is
 * recorded here, from the SERVICE layer (not the route layer) so that no
 * business change can happen without a trace.
 *
 * The audit table is append-only at the database level (see the init migration),
 * and writes never throw into the caller: a failed audit insert is logged
 * loudly but must not roll back the business operation that already succeeded -
 * except when the caller passes a transaction client, in which case the audit
 * row is part of the same transaction and DOES roll back with it (preferred for
 * anything money related).
 */
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { logger } from '../../utils/logger';
import type { AuditActionType } from '../../utils/auditActions';

export interface AuditContext {
  adminId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  action: AuditActionType | string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

/** JSON-safe clone that drops undefined, functions and circular references. */
function jsonSafe(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val))) as Prisma.InputJsonValue;
  } catch {
    return { unserializable: true } as Prisma.InputJsonValue;
  }
}

export async function recordAudit(context: AuditContext, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        adminId: context.adminId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        oldValue: jsonSafe(entry.oldValue),
        newValue: jsonSafe(entry.newValue),
        ip: context.ip ?? null,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
      },
    });
  } catch (error) {
    logger.error({ err: error, entry, context }, 'failed to write audit log');
  }
}

/**
 * Transactional audit write: the row is committed together with the change it
 * describes. Throws on failure (which aborts the transaction - intentional).
 */
export async function recordAuditTx(tx: Tx, context: AuditContext, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      adminId: context.adminId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      oldValue: jsonSafe(entry.oldValue),
      newValue: jsonSafe(entry.newValue),
      ip: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
    },
  });
}

/**
 * Builds the old/new pair for an update, keeping only the fields that actually
 * changed and never storing secrets.
 */
const SENSITIVE_KEYS = /password|secret|token|nid|hash/i;

export function diffChanges<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { oldValue: Partial<T>; newValue: Partial<T> } {
  const oldValue: Partial<T> = {};
  const newValue: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (JSON.stringify(beforeValue ?? null) === JSON.stringify(afterValue ?? null)) continue;
    if (SENSITIVE_KEYS.test(String(key))) {
      // record that the field changed, never the value itself
      oldValue[key] = (beforeValue === null || beforeValue === undefined ? beforeValue : '[redacted]') as T[keyof T];
      newValue[key] = (afterValue === null || afterValue === undefined ? afterValue : '[redacted]') as T[keyof T];
      continue;
    }
    oldValue[key] = beforeValue;
    newValue[key] = afterValue;
  }
  return { oldValue, newValue };
}

export const auditService = { recordAudit, recordAuditTx, diffChanges };
export default auditService;
