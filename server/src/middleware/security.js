/**
 * Security headers, CSRF/origin guard and the in-memory rate limiter.
 * Everything is hand-rolled (no helmet, no cors package).
 *
 * No CORS is needed in production: express serves both the SPA and the API on
 * the same origin. Cross-origin browser requests to state-changing routes are
 * rejected by `sameOriginGuard`; opt in explicitly with ALLOWED_ORIGINS.
 */
import { config } from '../config/index.js';
import { AppError, forbidden, tooMany } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'", // Vite injects a small inline style block for the SPA shell
  "script-src 'self'",
  config.isProd ? "connect-src 'self'" : "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
  "manifest-src 'self'",
];

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Origin-Agent-Cluster', '?1');
  if (config.isProd || req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
}

/** Requests from unknown origins are refused on unsafe methods (CSRF defence). */
export function sameOriginGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const referer = req.get('referer');
  const host = req.get('host');
  if (!origin && !referer) return next(); // non-browser client (curl, tests, gateway callback)

  const candidate = origin || safeOrigin(referer);
  if (!candidate) return next();

  const allowed = new Set([`${req.protocol}://${host}`, `https://${host}`, `http://${host}`, ...config.allowedOrigins]);
  let originHost = null;
  try {
    originHost = new URL(candidate).origin;
  } catch {
    return next(forbidden('Invalid Origin header'));
  }
  const hostVariants = new Set();
  for (const a of allowed) {
    try {
      hostVariants.add(new URL(a).origin);
    } catch {
      /* ignore malformed config entries */
    }
  }
  if (!hostVariants.has(originHost)) {
    logger.warn('blocked cross-origin request', { origin: originHost, method: req.method, path: req.path, ip: req.clientIp });
    return next(forbidden('Cross-origin request blocked'));
  }
  return next();
}

function safeOrigin(referer) {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory rate limiter (fixed window, per process - no Redis by design)
// ---------------------------------------------------------------------------
const stores = new Map();

function storeFor(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

// Periodic cleanup keeps memory bounded; unref so it never holds the process.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [name, store] of stores) {
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
    if (store.size === 0 && name !== 'default') stores.delete(name);
  }
}, 60_000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

export function resetRateLimits() {
  stores.clear();
}

/**
 * createRateLimiter({ name, windowMs, max, keyFn, message })
 * Emits X-RateLimit-* headers and 429 + Retry-After when exceeded.
 */
export function createRateLimiter({ name = 'default', windowMs, max, keyFn, message, skip }) {
  return function rateLimiter(req, res, next) {
    if (max <= 0 || (skip && skip(req))) return next();
    // Looked up per request (not captured): resetRateLimits() clears the
    // registry, and a captured store would keep counting after a reset.
    const store = storeFor(name);
    const key = String(keyFn ? keyFn(req) : req.clientIp || 'unknown');
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      logger.warn('rate limit exceeded', { limiter: name, key: maskKey(key), path: req.path, ip: req.clientIp });
      return next(tooMany(message));
    }
    return next();
  };
}

function maskKey(key) {
  const s = String(key);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

export const apiLimiter = createRateLimiter({
  name: 'api',
  windowMs: config.security.rateLimits.api.windowMs,
  max: config.security.rateLimits.api.max,
  keyFn: (req) => req.admin?.id ?? req.clientIp ?? 'unknown',
});

export const loginLimiter = createRateLimiter({
  name: 'login',
  windowMs: config.security.rateLimits.login.windowMs,
  max: config.security.rateLimits.login.max,
  keyFn: (req) => `${req.clientIp ?? 'unknown'}|${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
  message: 'Too many login attempts. Please wait and try again.',
});

export const loginIpLimiter = createRateLimiter({
  name: 'login-ip',
  windowMs: config.security.rateLimits.login.windowMs,
  max: Math.max(config.security.rateLimits.login.max * 3, 15),
  keyFn: (req) => req.clientIp ?? 'unknown',
  message: 'Too many login attempts from this address. Please wait and try again.',
});

export const payLimiter = createRateLimiter({
  name: 'pay',
  windowMs: config.security.rateLimits.pay.windowMs,
  max: config.security.rateLimits.pay.max,
  keyFn: (req) => req.clientIp ?? 'unknown',
  message: 'Too many requests. Please try again later.',
});

export const payStartLimiter = createRateLimiter({
  name: 'pay-start',
  windowMs: config.security.rateLimits.payStart.windowMs,
  max: config.security.rateLimits.payStart.max,
  keyFn: (req) => req.clientIp ?? 'unknown',
  message: 'Too many payment attempts. Please try again in a minute.',
});

/** Small helper for route-level guards (e.g. bulk SMS). */
export function rateLimit(options) {
  return createRateLimiter(options);
}

export { AppError };
