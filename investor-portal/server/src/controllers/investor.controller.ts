/** Investor + nominee HTTP handlers. Authorisation is applied by the router. */
import type { Request, Response } from 'express';
import * as investorService from '../services/investor/investor.service';
import type { InvestorActor } from '../services/investor/investor.service';
import { badRequest, unauthorized } from '../utils/errors';
import { getClientIp, getUserAgent } from '../utils/http';
import type { CreateInvestorInput, ListInvestorsQuery, UpdateInvestorInput } from '../validators/investor.validator';

export function actorOf(req: Request): InvestorActor {
  if (!req.admin) throw unauthorized();
  return { adminId: req.admin.id, role: req.admin.role, ip: getClientIp(req), userAgent: getUserAgent(req) };
}

/** GET /api/investors */
export async function list(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const result = await investorService.listInvestors(req.query as unknown as ListInvestorsQuery, actor.role);
  res.json(result);
}

/** GET /api/investors/:id */
export async function detail(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investor = await investorService.getInvestorById((req.params as { id: string }).id, actor.role);
  res.json({ investor });
}

/** POST /api/investors */
export async function create(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investor = await investorService.createInvestor(req.body as CreateInvestorInput, actor);
  res.status(201).json({ investor });
}

/** PATCH /api/investors/:id */
export async function update(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investor = await investorService.updateInvestor(
    (req.params as { id: string }).id,
    req.body as UpdateInvestorInput,
    actor,
  );
  res.json({ investor });
}

/** PUT /api/investors/:id/nominees (SUPER_ADMIN) */
export async function setNominees(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const { nominees } = req.body as { nominees: Parameters<typeof investorService.setNominees>[1] };
  const investor = await investorService.setNominees((req.params as { id: string }).id, nominees, actor);
  res.json({ investor });
}

/** POST /api/investors/:id/deactivate */
export async function deactivate(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investor = await investorService.setInvestorStatus((req.params as { id: string }).id, 'INACTIVE', actor);
  res.json({ investor });
}

/** POST /api/investors/:id/reactivate */
export async function reactivate(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const investor = await investorService.setInvestorStatus((req.params as { id: string }).id, 'ACTIVE', actor);
  res.json({ investor });
}

/** POST /api/investors/:id/photo (multipart, field `photo`) */
export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  if (!req.file) throw badRequest('No file uploaded (expected field "photo")');
  const result = await investorService.attachPhoto((req.params as { id: string }).id, req.file, actor);
  res.status(201).json(result);
}

/** POST /api/investors/:id/nid-scan (multipart, field `nidScan`, PRIVATE) */
export async function uploadNidScan(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  if (!req.file) throw badRequest('No file uploaded (expected field "nidScan")');
  const result = await investorService.attachNidScan((req.params as { id: string }).id, req.file, actor);
  res.status(201).json(result);
}

/** GET /api/investors/:id/nid-scan-url (SUPER_ADMIN, audited, short lived) */
export async function nidScanUrl(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const result = await investorService.getNidScanUrl((req.params as { id: string }).id, actor);
  res.json(result);
}
