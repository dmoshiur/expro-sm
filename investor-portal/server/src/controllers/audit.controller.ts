/**
 * Audit log read API (SUPER_ADMIN only). The table is append-only: there is no
 * endpoint to update or delete entries, and the database rejects such writes.
 */
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { buildPaginated, skipTake } from '../utils/http';
import { asyncHandler } from '../utils/asyncHandler';

export const listAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as {
    adminId?: string;
    action?: string;
    entity?: string;
    entityId?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  };

  const where: Prisma.AuditLogWhereInput = {
    ...(query.adminId ? { adminId: query.adminId } : {}),
    ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
    ...(query.entity ? { entity: query.entity } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { admin: { select: { id: true, name: true, email: true, role: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json(buildPaginated(items, total, query.page, query.pageSize));
});

/** Distinct action names, used to populate the UI filter dropdown. */
export const listAuditActions = asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
  res.json({ actions: rows.map((row) => row.action) });
});
