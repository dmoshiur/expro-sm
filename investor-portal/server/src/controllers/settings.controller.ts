import type { Request, Response } from 'express';
import * as settingsService from '../services/settings/settings.service';
import { getClientIp, getUserAgent } from '../utils/http';
import { unauthorized } from '../utils/errors';

function actorOf(req: Request) {
  if (!req.admin) throw unauthorized();
  return { adminId: req.admin.id, ip: getClientIp(req), userAgent: getUserAgent(req) };
}

/** GET /api/settings */
export async function list(_req: Request, res: Response): Promise<void> {
  res.json({ settings: await settingsService.listSettings() });
}

/** PUT /api/settings */
export async function update(req: Request, res: Response): Promise<void> {
  const settings = await settingsService.updateSettings(req.body as Record<string, string | number>, actorOf(req));
  res.json({ settings });
}
