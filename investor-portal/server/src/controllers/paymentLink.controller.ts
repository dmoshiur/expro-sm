/** Admin-facing payment link + SMS endpoints. */
import type { Request, Response } from 'express';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../config/prisma';
import * as linkService from '../services/payment/link.service';
import type { LinkContext } from '../services/payment/link.service';
import { unauthorized } from '../utils/errors';
import { buildPaginated, getClientIp, getUserAgent, skipTake } from '../utils/http';
import { maskMobile } from '../utils/encryption';

export function actorOf(req: Request): LinkContext {
  if (!req.admin) throw unauthorized();
  return { adminId: req.admin.id, ip: getClientIp(req), userAgent: getUserAgent(req) };
}

/** POST /api/payments/installments/:id/link/regenerate */
export async function regenerate(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const result = await linkService.regenerateLink((req.params as { id: string }).id, actor, {
    sendSms: Boolean((req.body as { sendSms?: boolean } | undefined)?.sendSms),
  });
  res.json(result);
}

/** POST /api/payments/installments/:id/link/send */
export async function sendLink(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const result = await linkService.sendLinkForInstallment((req.params as { id: string }).id, actor, {});
  res.json(result);
}

/** POST /api/payments/investments/:id/links/send */
export async function sendBulk(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const result = await linkService.sendLinksForInvestment((req.params as { id: string }).id, actor);
  res.json(result);
}

/** GET /api/payments/sms-logs */
export async function listSmsLogs(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as {
    investorId?: string;
    installmentId?: string;
    status?: 'QUEUED' | 'SENT' | 'FAILED';
    purpose?: 'PAYMENT_LINK' | 'REMINDER_DUE' | 'REMINDER_OVERDUE' | 'MANUAL' | 'BULK';
    search?: string;
    page: number;
    pageSize: number;
  };

  const where: Prisma.SmsLogWhereInput = {
    ...(query.investorId ? { investorId: query.investorId } : {}),
    ...(query.installmentId ? { installmentId: query.installmentId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.purpose ? { purpose: query.purpose } : {}),
    // NOTE: SQLite's LIKE (what Prisma's `contains` compiles to) is case-insensitive for
    // ASCII, so the PostgreSQL-only `mode: 'insensitive'` argument is not needed - SQLite
    // rejects it. Non-ASCII text (e.g. Bangla) is compared case-sensitively.
    ...(query.search
      ? {
          OR: [
            { toMobile: { contains: query.search } },
            { body: { contains: query.search } },
            { investor: { name: { contains: query.search } } },
          ],
        }
      : {}),
  };

  const { skip, take } = skipTake(query.page, query.pageSize);
  const [rows, total] = await Promise.all([
    prisma.smsLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        investor: { select: { id: true, name: true } },
        installment: { select: { id: true, serial: true, investmentId: true } },
      },
    }),
    prisma.smsLog.count({ where }),
  ]);

  const canSeeFullMobile = req.admin?.role === 'SUPER_ADMIN';
  const items = rows.map((row) => ({
    ...row,
    toMobile: canSeeFullMobile ? row.toMobile : maskMobile(row.toMobile),
  }));

  res.json(buildPaginated(items, total, query.page, query.pageSize));
}
