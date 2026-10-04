/**
 * Auth endpoints. Tokens travel in httpOnly cookies; the JSON response only
 * ever contains the admin profile (never a token) so that XSS cannot read them.
 */
import type { CookieOptions, Request, Response } from 'express';
import { config } from '../config';
import { prisma } from '../config/prisma';
import * as authService from '../services/auth/auth.service';
import { unauthorized } from '../utils/errors';
import { getClientIp, getUserAgent } from '../utils/http';
import { logger } from '../utils/logger';

const REFRESH_COOKIE_PATH = '/api/auth';

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'lax',
    domain: config.auth.cookieDomain,
  };
}

function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date): void {
  res.cookie(config.auth.accessCookieName, accessToken, {
    ...baseCookieOptions(),
    path: '/',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie(config.auth.refreshCookieName, refreshToken, {
    ...baseCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    expires: refreshExpiresAt,
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(config.auth.accessCookieName, { ...baseCookieOptions(), path: '/' });
  res.clearCookie(config.auth.refreshCookieName, { ...baseCookieOptions(), path: REFRESH_COOKIE_PATH });
}

const contextOf = (req: Request) => ({
  adminId: req.admin?.id ?? null,
  ip: getClientIp(req),
  userAgent: getUserAgent(req),
});

/** POST /api/auth/login */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password, totp } = req.body as { email: string; password: string; totp?: string };
  const result = await authService.login({ email, password, totp }, contextOf(req));

  if (result.status === 'two_factor_required') {
    res.json({ twoFactorRequired: true });
    return;
  }

  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);
  res.json({ admin: result.admin, mustEnable2FA: !result.admin.twoFAEnabled });
}

/** POST /api/auth/refresh */
export async function refresh(req: Request, res: Response): Promise<void> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[config.auth.refreshCookieName];
  if (!raw) throw unauthorized('No active session');

  const result = await authService.refresh(raw, contextOf(req));
  setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);
  res.json({ admin: result.admin });
}

/** POST /api/auth/logout */
export async function logout(req: Request, res: Response): Promise<void> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[config.auth.refreshCookieName];
  await authService.logout(raw, req.admin?.id, contextOf(req));
  clearAuthCookies(res);
  res.json({ ok: true });
}

/** GET /api/auth/me */
export async function me(req: Request, res: Response): Promise<void> {
  if (!req.admin) throw unauthorized();
  const admin = await prisma.admin.findUnique({
    where: { id: req.admin.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      twoFAEnabled: true,
      lastLoginAt: true,
      isActive: true,
      createdAt: true,
    },
  });
  if (!admin) throw unauthorized();
  res.json({ admin, mustEnable2FA: !admin.twoFAEnabled });
}

/** POST /api/auth/change-password */
export async function changePassword(req: Request, res: Response): Promise<void> {
  if (!req.admin) throw unauthorized();
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  await authService.changePassword(req.admin.id, currentPassword, newPassword, contextOf(req));
  // Every session was revoked: the caller must sign in again.
  clearAuthCookies(res);
  res.json({ ok: true, message: 'Password changed. Please sign in again.' });
}

/** POST /api/auth/2fa/setup */
export async function setupTwoFactor(req: Request, res: Response): Promise<void> {
  if (!req.admin) throw unauthorized();
  const setup = await authService.startTwoFactorSetup({ id: req.admin.id, email: req.admin.email }, contextOf(req));
  logger.info({ adminId: req.admin.id }, '2FA setup started');
  res.json({ otpauthUrl: setup.otpauthUrl, qrDataUrl: setup.qrDataUrl });
}

/** POST /api/auth/2fa/verify */
export async function verifyTwoFactor(req: Request, res: Response): Promise<void> {
  if (!req.admin) throw unauthorized();
  await authService.enableTwoFactor(req.admin.id, (req.body as { code: string }).code, contextOf(req));
  res.json({ ok: true, twoFAEnabled: true });
}

/** POST /api/auth/2fa/disable */
export async function disableTwoFactor(req: Request, res: Response): Promise<void> {
  if (!req.admin) throw unauthorized();
  await authService.disableTwoFactor(req.admin.id, (req.body as { password: string }).password, contextOf(req));
  res.json({ ok: true, twoFAEnabled: false });
}
