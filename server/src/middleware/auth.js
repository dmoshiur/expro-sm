/**
 * Authentication + RBAC middleware.
 *
 * requireAuth           -> 401 without a valid session cookie
 * requireRole(...roles) -> 403 unless the admin's role is in the list
 * The public /pay/:token flow deliberately has no session at all.
 */
import { config } from '../config/index.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { appendCookie } from './cookies.js';
import * as authService from '../services/auth.service.js';
import * as audit from '../services/audit.service.js';

export const COOKIE_OPTIONS = () => ({
  httpOnly: true,
  secure: config.security.cookieSecure,
  sameSite: 'Strict',
  path: '/',
  maxAge: config.security.sessionTtlHours * 3600_000,
});

export function setSessionCookie(res, token) {
  appendCookie(res, config.security.cookieName, token, COOKIE_OPTIONS());
}

export function clearSessionCookie(res) {
  const { maxAge, ...rest } = COOKIE_OPTIONS();
  appendCookie(res, config.security.cookieName, '', { ...rest, maxAge: 0, expires: new Date(0) });
}

/** Attaches req.admin / req.session when a valid cookie is present. */
export async function attachSession(req, res, next) {
  try {
    const token = req.cookies?.[config.security.cookieName];
    if (!token) return next();
    const session = await authService.resolveSession(token, req);
    if (!session) return next();
    req.session = session;
    req.admin = session.admin;
    if (authService.needsRotation(session)) {
      // Transparent rotation keeps long-lived tabs working while capping token lifetime.
      const rotated = await authService.rotateSession(session, req);
      setSessionCookie(res, rotated.token);
      req.session = { ...session, token: rotated.token, cached: false };
      req.log?.info('session rotated', { adminId: session.admin.id });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.admin) return next(unauthorized('Please sign in to continue'));
  return next();
}

/** Role gate. SUPER_ADMIN implies nothing else - roles are explicit. */
export function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return function roleGuard(req, res, next) {
    if (!req.admin) return next(unauthorized('Please sign in to continue'));
    if (!allowed.has(req.admin.role)) {
      audit
        .record({
          action: audit.AUDIT_ACTIONS.UNAUTHORIZED_ATTEMPT,
          entity: 'route',
          entityId: `${req.method} ${req.baseUrl}${req.path}`,
          meta: { requiredRoles: [...allowed], role: req.admin.role },
          actor: req.admin,
          req,
        })
        .catch(() => {});
      return next(forbidden('You do not have permission to perform this action'));
    }
    return next();
  };
}

export const ROLES = authService.ROLES;
export const requireSuperAdmin = requireRole('SUPER_ADMIN');
export const requireAccountant = requireRole('SUPER_ADMIN', 'ACCOUNTANT');
export const requireAnyRole = requireRole('SUPER_ADMIN', 'ACCOUNTANT', 'VIEWER');
