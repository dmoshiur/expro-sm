/**
 * Minimal cookie parser + serialiser (no cookie-parser dependency).
 * Values are percent-encoded on write and decoded on read.
 */
import { AppError } from '../utils/errors.js';

export function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function cookiesMiddleware(req, _res, next) {
  req.cookies = parseCookieHeader(req.headers.cookie);
  next();
}

export function serializeCookie(name, value, options = {}) {
  const {
    maxAge,
    expires,
    path = '/',
    domain,
    secure = false,
    httpOnly = true,
    sameSite = 'Strict',
  } = options;
  if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) throw new AppError(500, 'BAD_COOKIE_NAME', 'Invalid cookie name');
  const parts = [`${name}=${encodeURIComponent(String(value ?? ''))}`];
  parts.push(`Path=${path}`);
  if (domain) parts.push(`Domain=${domain}`);
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  parts.push(`SameSite=${sameSite}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function appendCookie(res, name, value, options) {
  const cookie = serializeCookie(name, value, options);
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

export function clearCookie(res, name, options = {}) {
  appendCookie(res, name, '', { ...options, maxAge: 0, expires: new Date(0) });
}
