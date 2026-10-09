/** Request id, client IP and per-request logger. */
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = incoming && /^[\w.-]{6,60}$/.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);

  const forwarded = config.trustProxy > 0 ? req.headers['x-forwarded-for'] : undefined;
  const first = Array.isArray(forwarded) ? forwarded[0] : String(forwarded ?? '').split(',')[0].trim();
  const ip = first || req.socket?.remoteAddress || '';
  req.clientIp = normalizeIp(ip);
  req.isHttps = Boolean(req.secure) || String(req.get('x-forwarded-proto') ?? '') === 'https';
  req.log = logger.child({ reqId: id });

  // Captured now: Express rewinds req.url while unwinding routers, so reading
  // req.path in the finish handler would only give the router-relative path.
  const fullPath = String(req.originalUrl ?? req.url ?? '').split('?')[0];

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http request', {
      reqId: id,
      method: req.method,
      path: fullPath,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.clientIp,
      role: req.admin?.role,
      adminId: req.admin?.id,
    });
  });
  next();
}

/** Postgres `inet` accepts the bare address; strip IPv6-mapped IPv4 prefix. */
function normalizeIp(ip) {
  const value = String(ip ?? '').trim();
  if (!value) return null;
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value.slice(0, 45);
}
