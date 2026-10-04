/** Investment + installment HTTP handlers. */
import type { Request, Response } from 'express';
import * as installmentService from '../services/installment/installment.service';
import type { InvestmentActor } from '../services/installment/installment.service';
import { unauthorized } from '../utils/errors';
import { getClientIp, getUserAgent } from '../utils/http';
import type {
  CreateInvestmentInput,
  ListInstallmentsQuery,
  ListInvestmentsQuery,
  UpdateInstallmentsInput,
} from '../validators/investment.validator';

export function actorOf(req: Request): InvestmentActor {
  if (!req.admin) throw unauthorized();
  return { adminId: req.admin.id, role: req.admin.role, ip: getClientIp(req), userAgent: getUserAgent(req) };
}

/** GET /api/investments */
export async function list(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const result = await installmentService.listInvestments(req.query as unknown as ListInvestmentsQuery, actor.role);
  res.json(result);
}

/** GET /api/investments/:id */
export async function detail(req: Request, res: Response): Promise<void> {
  const investment = await installmentService.getInvestmentById((req.params as { id: string }).id);
  res.json({ investment });
}

/** POST /api/investments */
export async function create(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.createInvestment(req.body as CreateInvestmentInput, actor);
  res.status(201).json({ investment });
}

/** PATCH /api/investments/:id */
export async function update(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.updateInvestment(
    (req.params as { id: string }).id,
    req.body as { notes?: string | null; status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' },
    actor,
  );
  res.json({ investment });
}

/** POST /api/investments/:id/cancel */
export async function cancel(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.cancelInvestment(
    (req.params as { id: string }).id,
    (req.body as { reason: string }).reason,
    actor,
  );
  res.json({ investment });
}

/** PUT /api/investments/:id/installments */
export async function updateInstallments(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.updateInstallments(
    (req.params as { id: string }).id,
    req.body as UpdateInstallmentsInput,
    actor,
  );
  res.json({ investment });
}

/** GET /api/installments */
export async function listInstallments(req: Request, res: Response): Promise<void> {
  const result = await installmentService.listInstallments(req.query as unknown as ListInstallmentsQuery);
  res.json(result);
}

/** POST /api/installments/:id/waive */
export async function waive(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.waiveInstallment(
    (req.params as { id: string }).id,
    (req.body as { reason: string }).reason,
    actor,
  );
  res.json({ investment });
}

/** POST /api/installments/:id/cancel */
export async function cancelInstallment(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.cancelInstallment(
    (req.params as { id: string }).id,
    (req.body as { reason: string }).reason,
    actor,
  );
  res.json({ investment });
}

/** POST /api/installments/:id/reopen */
export async function reopen(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investment = await installmentService.reopenInstallment(
    (req.params as { id: string }).id,
    (req.body as { reason: string }).reason,
    actor,
  );
  res.json({ investment });
}
