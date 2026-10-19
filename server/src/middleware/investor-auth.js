/**
 * Investor-portal authentication middleware.
 *
 * Deliberately separate from middleware/auth.js: a different cookie name, a
 * different session table and `req.investor` instead of `req.admin`, so the
 * two login systems can never be confused for each other. Both attachers run
 * on every request; each only looks at its own cookie, which also lets an
 * admin stay signed in while testing the investor portal in the same browser.
 */
import { config } from '../config/index.js';
import { AppError, unauthorized } from '../utils/errors.js';
import { appendCookie } from './cookies.js';
import * as investorAuth from '../services/investor-auth.service.js';

export const INVESTOR_COOKIE_OPTIONS = () => ({
  httpOnly: true,
  secure: config.security.cookieSecure,
  sameSite: 'Strict',
  path: '/',
  maxAge: config.security.investorSessionTtlHours * 3600_000,
});

export function setInvestorSessionCookie(res, token) {
  appendCookie(res, config.security.investorCookieName, token, INVESTOR_COOKIE_OPTIONS());
}

export function clearInvestorSessionCookie(res) {
  const { maxAge, ...rest } = INVESTOR_COOKIE_OPTIONS();
  appendCookie(res, config.security.investorCookieName, '', { ...rest, maxAge: 0, expires: new Date(0) });
}

/** Attaches req.investor / req.investorSession when a valid cookie is present. */
export async function attachInvestorSession(req, res, next) {
  try {
    const token = req.cookies?.[config.security.investorCookieName];
    if (!token) return next();
    const session = await investorAuth.resolveInvestorSession(token, req);
    if (!session) return next();
    req.investorSession = session;
    req.investor = session.investor;
    if (investorAuth.needsInvestorRotation(session)) {
      const rotated = await investorAuth.rotateInvestorSession(session, req);
      setInvestorSessionCookie(res, rotated.token);
      req.investorSession = { ...session, token: rotated.token, cached: false };
      req.log?.info('investor session rotated', { investorId: session.investor.id });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireInvestorAuth(req, _res, next) {
  if (!req.investor) return next(unauthorized('Please sign in to the investor portal to continue'));
  return next();
}

/**
 * Admin-issued passwords are temporary. Until the investor replaces theirs,
 * only /auth/me, /auth/change-password and /auth/logout are usable - every
 * other portal route answers 403 PASSWORD_CHANGE_REQUIRED (the client routes
 * straight to the change-password screen).
 */
export function requirePasswordChanged(req, _res, next) {
  if (req.investor?.must_change_password) {
    return next(
      new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please change your temporary password before continuing', {
        mustChangePassword: true,
      }),
    );
  }
  return next();
}
