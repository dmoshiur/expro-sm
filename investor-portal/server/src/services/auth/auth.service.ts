/**
 * Authentication service: login, lockout, refresh rotation, logout,
 * password change and 2FA lifecycle. Passwords are hashed with argon2id.
 */
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import type { Admin } from '@prisma/client';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { badRequest, forbidden, NotFoundError, unauthorized } from '../../utils/errors';
import { encrypt } from '../../utils/encryption';
import { logger } from '../../utils/logger';
import { AuditAction } from '../../utils/auditActions';
import { recordAudit, type AuditContext } from '../audit/audit.service';
import * as tokenService from './token.service';
import * as twoFactorService from './twofa.service';

export interface LoginInput {
  email: string;
  password: string;
  totp?: string;
}

export type LoginResult =
  | { status: 'two_factor_required' }
  | {
      status: 'ok';
      admin: Pick<Admin, 'id' | 'name' | 'email' | 'role' | 'twoFAEnabled'>;
      accessToken: string;
      refreshToken: string;
      refreshExpiresAt: Date;
    };

const argonOptions: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB (OWASP recommended minimum)
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, argonOptions);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

function isLocked(admin: Admin): boolean {
  return Boolean(admin.lockedUntil && admin.lockedUntil.getTime() > Date.now());
}

/**
 * Password login. Handles lockout, disabled accounts and the optional TOTP
 * second factor. Deliberately returns the same generic error for "unknown
 * email" and "wrong password".
 */
export async function login(input: LoginInput, context: AuditContext): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  const admin = await prisma.admin.findUnique({ where: { email } });
  const genericFailure = unauthorized('Invalid email or password');

  if (!admin) {
    await recordAudit({ ...context, adminId: null }, {
      action: AuditAction.LOGIN_FAILED,
      entity: 'Admin',
      newValue: { email, reason: 'unknown_email' },
    });
    throw genericFailure;
  }

  if (isLocked(admin)) {
    await recordAudit({ ...context, adminId: admin.id }, {
      action: AuditAction.LOGIN_LOCKED,
      entity: 'Admin',
      entityId: admin.id,
      newValue: { lockedUntil: admin.lockedUntil?.toISOString() },
    });
    throw forbidden(
      `Account temporarily locked after too many failed attempts. Try again after ${admin.lockedUntil?.toISOString()}.`,
    );
  }

  if (!admin.isActive) {
    await recordAudit({ ...context, adminId: admin.id }, {
      action: AuditAction.LOGIN_FAILED,
      entity: 'Admin',
      entityId: admin.id,
      newValue: { reason: 'account_disabled' },
    });
    throw forbidden('This account has been disabled. Contact a super admin.');
  }

  const passwordOk = await verifyPassword(admin.passwordHash, input.password);
  if (!passwordOk) {
    const failedLoginCount = admin.failedLoginCount + 1;
    const shouldLock = failedLoginCount >= config.auth.maxLoginAttempts;
    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        failedLoginCount,
        lockedUntil: shouldLock ? new Date(Date.now() + config.auth.lockoutMinutes * 60_000) : null,
      },
    });
    await recordAudit({ ...context, adminId: admin.id }, {
      action: shouldLock ? AuditAction.LOGIN_LOCKED : AuditAction.LOGIN_FAILED,
      entity: 'Admin',
      entityId: admin.id,
      newValue: { failedLoginCount, locked: shouldLock },
    });
    if (shouldLock) {
      throw forbidden('Too many failed attempts. The account is locked temporarily.');
    }
    throw genericFailure;
  }

  // Password is correct from here on.
  if (admin.twoFAEnabled) {
    if (!input.totp) {
      return { status: 'two_factor_required' };
    }
    const codeOk = await twoFactorService.verify(admin.twoFASecret, input.totp);
    if (!codeOk) {
      await recordAudit({ ...context, adminId: admin.id }, {
        action: AuditAction.TWO_FA_FAILED,
        entity: 'Admin',
        entityId: admin.id,
      });
      throw unauthorized('Invalid two-factor code');
    }
  }

  const accessToken = tokenService.signAccessToken(admin);
  const refresh = await tokenService.issueRefreshToken(admin.id, {
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await prisma.admin.update({
    where: { id: admin.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await recordAudit({ ...context, adminId: admin.id }, {
    action: AuditAction.LOGIN_SUCCESS,
    entity: 'Admin',
    entityId: admin.id,
    newValue: { email: admin.email, role: admin.role, twoFactor: admin.twoFAEnabled },
  });

  return {
    status: 'ok',
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      twoFAEnabled: admin.twoFAEnabled,
    },
    accessToken,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export async function refresh(rawToken: string, context: AuditContext) {
  const rotated = await tokenService.rotateRefreshToken(rawToken, {
    ip: context.ip,
    userAgent: context.userAgent,
  });
  const accessToken = tokenService.signAccessToken(rotated.admin);
  await recordAudit({ ...context, adminId: rotated.admin.id }, {
    action: AuditAction.TOKEN_REFRESH,
    entity: 'Admin',
    entityId: rotated.admin.id,
  });
  return {
    accessToken,
    refreshToken: rotated.token,
    refreshExpiresAt: rotated.expiresAt,
    admin: {
      id: rotated.admin.id,
      name: rotated.admin.name,
      email: rotated.admin.email,
      role: rotated.admin.role,
      twoFAEnabled: rotated.admin.twoFAEnabled,
    },
  };
}

export async function logout(rawToken: string | undefined, adminId: string | undefined, context: AuditContext) {
  if (rawToken) await tokenService.revokeRefreshToken(rawToken);
  if (adminId) {
    await recordAudit({ ...context, adminId }, { action: AuditAction.LOGOUT, entity: 'Admin', entityId: adminId });
  }
}

export async function changePassword(
  adminId: string,
  currentPassword: string,
  newPassword: string,
  context: AuditContext,
) {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) throw unauthorized();

  const ok = await verifyPassword(admin.passwordHash, currentPassword);
  if (!ok) throw badRequest('Your current password is incorrect');
  if (await verifyPassword(admin.passwordHash, newPassword)) {
    throw badRequest('The new password must be different from the current one');
  }

  await prisma.admin.update({
    where: { id: adminId },
    data: { passwordHash: await hashPassword(newPassword), failedLoginCount: 0, lockedUntil: null },
  });
  const revoked = await tokenService.revokeAllRefreshTokens(adminId);
  await recordAudit({ ...context, adminId }, {
    action: AuditAction.PASSWORD_CHANGED,
    entity: 'Admin',
    entityId: adminId,
    newValue: { sessionsRevoked: revoked },
  });
  logger.info({ adminId, sessionsRevoked: revoked }, 'password changed');
}

// ------------------------------- 2FA ---------------------------------------

export async function startTwoFactorSetup(admin: { id: string; email: string }, context: AuditContext) {
  const setup = await twoFactorService.beginSetup(admin.id, admin.email);
  await recordAudit({ ...context, adminId: admin.id }, {
    action: AuditAction.TWO_FA_SETUP_STARTED,
    entity: 'Admin',
    entityId: admin.id,
  });
  return setup;
}

export async function enableTwoFactor(adminId: string, code: string, context: AuditContext) {
  await twoFactorService.confirmSetup(adminId, code);
  await recordAudit({ ...context, adminId }, {
    action: AuditAction.TWO_FA_ENABLED,
    entity: 'Admin',
    entityId: adminId,
  });
}

export async function disableTwoFactor(adminId: string, password: string, context: AuditContext) {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) throw unauthorized();
  if (!(await verifyPassword(admin.passwordHash, password))) {
    throw badRequest('Password is incorrect');
  }
  await twoFactorService.disable(adminId);
  await recordAudit({ ...context, adminId }, {
    action: AuditAction.TWO_FA_DISABLED,
    entity: 'Admin',
    entityId: adminId,
  });
}

/**
 * SUPER_ADMIN only: reset another admin's 2FA (e.g. lost phone).
 * A fresh pending secret is generated and 2FA is switched off until the target
 * admin completes enrolment again; every session of that admin is terminated.
 */
export async function resetTwoFactor(
  targetAdminId: string,
  context: AuditContext,
): Promise<{ pendingSecret: string }> {
  const target = await prisma.admin.findUnique({ where: { id: targetAdminId } });
  if (!target) throw new NotFoundError('Admin');

  const secret = authenticator.generateSecret(20);
  await prisma.admin.update({
    where: { id: targetAdminId },
    data: { twoFASecret: encrypt(secret), twoFAEnabled: false, failedLoginCount: 0, lockedUntil: null },
  });
  const revoked = await tokenService.revokeAllRefreshTokens(targetAdminId);
  await recordAudit(context, {
    action: AuditAction.TWO_FA_RESET,
    entity: 'Admin',
    entityId: targetAdminId,
    oldValue: { twoFAEnabled: target.twoFAEnabled, locked: Boolean(target.lockedUntil) },
    newValue: { twoFAEnabled: false, sessionsRevoked: revoked, resetBy: context.adminId },
  });
  return { pendingSecret: secret };
}

export const authService = {
  login,
  refresh,
  logout,
  changePassword,
  hashPassword,
  verifyPassword,
  startTwoFactorSetup,
  enableTwoFactor,
  disableTwoFactor,
  resetTwoFactor,
};
export default authService;
