/**
 * Admin management (SUPER_ADMIN only).
 *
 * Creating, disabling, changing roles, resetting passwords and resetting 2FA.
 * Every mutation is audited with old/new values. A super admin cannot demote or
 * disable themselves - that protects the last remaining super admin.
 */
import type { Request, Response } from 'express';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../config/prisma';
import * as authService from '../services/auth/auth.service';
import { tokenService } from '../services/auth/token.service';
import { recordAudit } from '../services/audit/audit.service';
import { AuditAction } from '../utils/auditActions';
import { badRequest, conflict, NotFoundError } from '../utils/errors';
import { buildPaginated, getClientIp, getUserAgent, skipTake } from '../utils/http';
import { logger } from '../utils/logger';

const contextOf = (req: Request) => ({
  adminId: req.admin?.id ?? null,
  ip: getClientIp(req),
  userAgent: getUserAgent(req),
});

const ADMIN_PUBLIC_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  twoFAEnabled: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AdminSelect;

/** GET /api/admins */
export async function listAdmins(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as {
    search?: string;
    role?: 'SUPER_ADMIN' | 'ACCOUNTANT' | 'VIEWER';
    isActive?: boolean;
    page: number;
    pageSize: number;
  };

  const where: Prisma.AdminWhereInput = {
    ...(query.role ? { role: query.role } : {}),
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    // NOTE: SQLite's LIKE (what Prisma's `contains` compiles to) is case-insensitive for
    // ASCII, so the PostgreSQL-only `mode: 'insensitive'` argument is not needed - SQLite
    // rejects it. Non-ASCII text (e.g. Bangla) is compared case-sensitively.
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { email: { contains: query.search } },
          ],
        }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const [items, total] = await Promise.all([
    prisma.admin.findMany({ where, select: ADMIN_PUBLIC_FIELDS, orderBy: [{ role: 'asc' }, { name: 'asc' }], skip, take }),
    prisma.admin.count({ where }),
  ]);

  res.json(buildPaginated(items, total, query.page, query.pageSize));
}

/** POST /api/admins */
export async function createAdmin(req: Request, res: Response): Promise<void> {
  const body = req.body as { name: string; email: string; password: string; role: 'SUPER_ADMIN' | 'ACCOUNTANT' | 'VIEWER' };

  const existing = await prisma.admin.findUnique({ where: { email: body.email } });
  if (existing) throw conflict('An admin with that email already exists');

  const admin = await prisma.admin.create({
    data: {
      name: body.name,
      email: body.email,
      passwordHash: await authService.hashPassword(body.password),
      role: body.role,
    },
    select: ADMIN_PUBLIC_FIELDS,
  });

  await recordAudit(contextOf(req), {
    action: AuditAction.ADMIN_CREATED,
    entity: 'Admin',
    entityId: admin.id,
    newValue: { name: admin.name, email: admin.email, role: admin.role },
  });

  logger.info({ createdBy: req.admin?.id, adminId: admin.id, role: admin.role }, 'admin created');
  res.status(201).json({ admin });
}

/** PATCH /api/admins/:id */
export async function updateAdmin(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const body = req.body as { name?: string; role?: 'SUPER_ADMIN' | 'ACCOUNTANT' | 'VIEWER'; isActive?: boolean };

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw new NotFoundError('Admin');

  const isSelf = req.admin?.id === id;
  if (isSelf && body.role && body.role !== target.role) {
    throw badRequest('You cannot change your own role');
  }
  if (isSelf && body.isActive === false) {
    throw badRequest('You cannot disable your own account');
  }

  // Never allow the platform to end up with zero active super admins.
  const removesSuperAdmin =
    target.role === 'SUPER_ADMIN' && ((body.role && body.role !== 'SUPER_ADMIN') || body.isActive === false);
  if (removesSuperAdmin) {
    const activeSuperAdmins = await prisma.admin.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
    if (activeSuperAdmins <= 1) throw badRequest('At least one active super admin must remain');
  }

  const updated = await prisma.admin.update({
    where: { id },
    data: {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      // unblock a locked account when it is re-enabled
      ...(body.isActive === true ? { failedLoginCount: 0, lockedUntil: null } : {}),
    },
    select: ADMIN_PUBLIC_FIELDS,
  });

  if (body.isActive === false || (body.role && body.role !== target.role)) {
    await tokenService.revokeAllRefreshTokens(id);
  }

  const action =
    body.isActive === false
      ? AuditAction.ADMIN_DISABLED
      : body.isActive === true && target.isActive === false
        ? AuditAction.ADMIN_ENABLED
        : body.role && body.role !== target.role
          ? AuditAction.ADMIN_ROLE_CHANGED
          : AuditAction.ADMIN_UPDATED;

  await recordAudit(contextOf(req), {
    action,
    entity: 'Admin',
    entityId: id,
    oldValue: { name: target.name, role: target.role, isActive: target.isActive },
    newValue: { name: updated.name, role: updated.role, isActive: updated.isActive },
  });

  res.json({ admin: updated });
}

/** POST /api/admins/:id/reset-password */
export async function resetAdminPassword(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const { newPassword } = req.body as { newPassword: string };

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw new NotFoundError('Admin');

  await prisma.admin.update({
    where: { id },
    data: {
      passwordHash: await authService.hashPassword(newPassword),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  const revoked = await tokenService.revokeAllRefreshTokens(id);

  await recordAudit(contextOf(req), {
    action: AuditAction.ADMIN_PASSWORD_RESET,
    entity: 'Admin',
    entityId: id,
    newValue: { sessionsRevoked: revoked },
  });

  res.json({ ok: true });
}

/** POST /api/admins/:id/reset-2fa */
export async function resetAdminTwoFactor(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const result = await authService.resetTwoFactor(id, contextOf(req));
  res.json({ ok: true, pendingSecret: result.pendingSecret });
}

/** POST /api/admins/:id/unlock */
export async function unlockAdmin(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw new NotFoundError('Admin');

  const updated = await prisma.admin.update({
    where: { id },
    data: { failedLoginCount: 0, lockedUntil: null },
    select: ADMIN_PUBLIC_FIELDS,
  });

  await recordAudit(contextOf(req), {
    action: AuditAction.ADMIN_UPDATED,
    entity: 'Admin',
    entityId: id,
    oldValue: { lockedUntil: target.lockedUntil, failedLoginCount: target.failedLoginCount },
    newValue: { lockedUntil: null, failedLoginCount: 0, reason: 'manual unlock' },
  });

  res.json({ admin: updated });
}
