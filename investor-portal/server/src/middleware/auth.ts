/**
 * Authentication + authorisation middleware.
 *
 * - `requireAuth`     : verifies the access token (cookie or Bearer header),
 *                       loads the admin, rejects disabled/deleted accounts
 * - `requireRole`     : role allow-list (SUPER_ADMIN / ACCOUNTANT / VIEWER)
 * - `requirePermission`: permission matrix from utils/permissions.ts
 * - `optionalAuth`    : attaches the admin when present, never rejects
 */
import type { AdminRole } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import { prisma } from '../config/prisma';
import { forbidden, unauthorized } from '../utils/errors';
import { assertPermission, roleHasPermission, type Permission } from '../utils/permissions';
import { verifyAccessToken } from '../services/auth/token.service';

function extractToken(req: Request): string | undefined {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[config.auth.accessCookieName];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return undefined;
}

async function loadAdmin(req: Request, token: string): Promise<void> {
  const payload = verifyAccessToken(token);
  const admin = await prisma.admin.findUnique({
    where: { id: payload.sub },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  if (!admin) throw unauthorized('Your account no longer exists.');
  if (!admin.isActive) throw forbidden('This account has been disabled.');
  req.admin = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    next(unauthorized('Please sign in to continue.'));
    return;
  }
  void loadAdmin(req, token)
    .then(() => next())
    .catch((error: unknown) => next(error));
};

export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }
  void loadAdmin(req, token)
    .then(() => next())
    .catch(() => next());
};

export const requireRole =
  (...roles: AdminRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.admin) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.admin.role)) {
      next(forbidden(`This action requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.admin) {
      next(unauthorized());
      return;
    }
    try {
      assertPermission(req.admin.role, permission);
      next();
    } catch (error) {
      next(error);
    }
  };

/** Request-time permission probe used by the UI to hide actions. */
export const can = (req: Request, permission: Permission): boolean =>
  Boolean(req.admin && roleHasPermission(req.admin.role, permission));

/** Small helper for controllers that want the admin and 401 otherwise. */
export function currentAdmin(req: Request): Express.AuthAdmin {
  if (!req.admin) throw unauthorized();
  return req.admin;
}

export type { Response, NextFunction };
