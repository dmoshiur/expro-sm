/**
 * Rate limiting.
 *
 * - `apiLimiter`      : broad protection for every authenticated admin route
 * - `authLimiter`     : login / 2FA / forgot-password (brute-force protection)
 * - `publicPayLimiter`: the public payment page and payment start endpoint
 * - `sensitiveLimiter`: NID image access and exports
 *
 * Express behind Nginx needs `app.set('trust proxy', 1)` for req.ip to be the
 * real client address - see src/app.ts.
 */
import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';

const disabled = process.env.RATE_LIMIT_DISABLED === '1';

const jsonHandler = (message: string) => (req: Request, res: Response) => {
  logger.warn({ requestId: req.id, ip: req.ip, url: req.originalUrl }, 'rate limit exceeded');
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message, requestId: req.id ?? 'unknown' },
  });
};

function make(options: Partial<Options> & { message: string; windowMs: number; limit: number }) {
  const { message, ...rest } = options;
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => disabled,
    handler: jsonHandler(message),
    ...rest,
  });
}

/** 600 requests / minute / identity - generous, protects against runaway loops. */
export const apiLimiter = make({
  windowMs: 60_000,
  limit: 600,
  keyGenerator: (req: Request) =>
    req.admin?.id ?? `ip:${requestIp(req)}`,
  message: 'Too many requests. Please slow down.',
});

/** 10 login attempts / 15 min / IP (plus per-account lockout in the service). */
export const authLimiter = make({
  windowMs: 15 * 60_000,
  limit: 10,
  keyGenerator: (req: Request) => `auth:${requestIp(req)}`,
  message: 'Too many authentication attempts. Please try again in a few minutes.',
});

/** Public payment pages: 60 requests / 10 min / IP. */
export const publicPayLimiter = make({
  windowMs: 10 * 60_000,
  limit: 60,
  keyGenerator: (req: Request) => `pay:${requestIp(req)}`,
  message: 'Too many requests from this network. Please try again later.',
});

/** Expensive / sensitive reads (NID images, PDF/Excel exports). */
export const sensitiveLimiter = make({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (req: Request) => `sens:${req.admin?.id ?? requestIp(req)}`,
  message: 'Too many sensitive requests. Please try again in a minute.',
});

/** Normalises IPv4-mapped IPv6 addresses so limits are per client, not per socket. */
function requestIp(req: Request): string {
  const ip = req.ip ?? 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export const noopLimiter = (_req: Request, _res: Response, next: NextFunction): void => next();
export const rateLimitsEnabled = !disabled && !config.isTest;
