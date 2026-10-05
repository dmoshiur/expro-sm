/**
 * JWT access tokens + rotating refresh tokens.
 *
 * Access token : short lived (JWT_ACCESS_TTL, default 15m), sent as an
 *                httpOnly+Secure+SameSite cookie (and optionally as a Bearer
 *                header for API clients / Postman).
 * Refresh token: long lived (JWT_REFRESH_TTL, default 7d), stored ONLY as a
 *                SHA-256 hash. Every refresh invalidates the presented token and
 *                issues a new one (rotation). Presenting an already-rotated
 *                token is treated as theft: the whole token family for that
 *                admin is revoked immediately.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Admin, AdminRole } from '../../generated/prisma/client';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { unauthorized } from '../../utils/errors';
import { sha256 } from '../../utils/encryption';
import { logger } from '../../utils/logger';
import { AuditAction } from '../../utils/auditActions';
import { recordAudit } from '../audit/audit.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: AdminRole;
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface RefreshContext {
  ip?: string | null;
  userAgent?: string | null;
}

export function signAccessToken(admin: Pick<Admin, 'id' | 'email' | 'name' | 'role'>): string {
  const payload: Omit<AccessTokenPayload, 'iat' | 'exp'> = {
    sub: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    type: 'access',
  };
  return jwt.sign(payload, config.auth.accessSecret, {
    expiresIn: config.auth.accessTtl as jwt.SignOptions['expiresIn'],
    issuer: 'investor-portal',
    audience: 'investor-portal-admin',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, config.auth.accessSecret, {
      issuer: 'investor-portal',
      audience: 'investor-portal-admin',
    }) as AccessTokenPayload;
    if (decoded.type !== 'access') throw new Error('wrong token type');
    return decoded;
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

export function refreshTtlMs(): number {
  const ttl = config.auth.refreshTtl;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * factor;
}

export async function issueRefreshToken(
  adminId: string,
  context: RefreshContext,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + refreshTtlMs());
  await prisma.refreshToken.create({
    data: {
      adminId,
      tokenHash: sha256(token),
      expiresAt,
      ip: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
    },
  });
  return { token, expiresAt };
}

/**
 * Rotates a refresh token. Returns the admin to authenticate and the new token.
 * Throws 401 for unknown, expired or revoked tokens.
 */
export async function rotateRefreshToken(
  rawToken: string,
  context: RefreshContext,
): Promise<{ admin: Admin; token: string; expiresAt: Date }> {
  const tokenHash = sha256(rawToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { admin: true },
  });

  if (!existing) throw unauthorized('Session not recognised. Please sign in again.');

  // Reuse detection: this token was already rotated => assume compromise.
  if (existing.revokedAt) {
    logger.warn(
      { adminId: existing.adminId, requestId: undefined },
      'refresh token reuse detected - revoking every session for this admin',
    );
    await prisma.refreshToken.updateMany({
      where: { adminId: existing.adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAudit(
      { adminId: existing.adminId, ip: context.ip, userAgent: context.userAgent },
      { action: AuditAction.TOKEN_REUSE_DETECTED, entity: 'Admin', entityId: existing.adminId },
    );
    throw unauthorized('Session no longer valid. Please sign in again.');
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    throw unauthorized('Session expired. Please sign in again.');
  }
  if (!existing.admin.isActive) {
    throw unauthorized('This account has been disabled.');
  }

  const rotated = await prisma.$transaction(async (tx) => {
    const next = crypto.randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + refreshTtlMs());
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByHash: sha256(next) },
    });
    await tx.refreshToken.create({
      data: {
        adminId: existing.adminId,
        tokenHash: sha256(next),
        expiresAt,
        ip: context.ip ?? null,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
      },
    });
    return { token: next, expiresAt };
  });

  return { admin: existing.admin, token: rotated.token, expiresAt: rotated.expiresAt };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({ where: { tokenHash: sha256(rawToken), revokedAt: null }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

/** Used on password change, disable, 2FA reset: kills every session. */
export async function revokeAllRefreshTokens(adminId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { adminId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export const tokenService = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  refreshTtlMs,
};
export default tokenService;
