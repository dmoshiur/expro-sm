/**
 * CSRF hardening for cookie-authenticated routes.
 *
 * The API authenticates with httpOnly SameSite=Lax cookies. SameSite=Lax
 * already blocks cross-site POSTs in every modern browser, and CORS restricts
 * which origins may read responses. As defence in depth we additionally require
 * that any state-changing request carrying an auth cookie comes from one of the
 * configured origins.
 *
 * Requests without a cookie (API clients using a Bearer token, gateway
 * webhooks, server-to-server calls) are not CSRF-able and pass through.
 */
import type { RequestHandler } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfProtection: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const hasAuthCookie = Boolean(
    (req.cookies as Record<string, string> | undefined)?.[config.auth.accessCookieName] ||
      (req.cookies as Record<string, string> | undefined)?.[config.auth.refreshCookieName],
  );
  if (!hasAuthCookie) {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (origin && !config.corsOrigins.includes(origin)) {
    logger.warn({ origin, url: req.originalUrl, requestId: req.id }, 'CSRF protection rejected request');
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Origin not allowed', requestId: req.id ?? 'unknown' },
    });
    return;
  }
  next();
};

export default csrfProtection;
