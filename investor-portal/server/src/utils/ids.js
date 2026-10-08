/** Random ids, hashing, constant-time comparison helpers built on node:crypto. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe 256-bit token (payment links, session ids). */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(prefix = '') {
  return `${prefix}${randomUUID()}`;
}

/** Constant-time string comparison (length differences are handled safely). */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length === 0 || bufB.length === 0) return false;
  if (bufA.length !== bufB.length) {
    // still burn a comparison to keep timing flat-ish
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Human-friendly receipt / reference numbers: RCPT-2026-000123. */
export function formatReceiptNumber(id, instant = new Date()) {
  const year = new Date(instant.getTime() + 6 * 3600_000).getUTCFullYear();
  return `RCPT-${year}-${String(id).padStart(6, '0')}`;
}

export function formatInvoiceNumber(installmentId, instant = new Date()) {
  const year = new Date(instant.getTime() + 6 * 3600_000).getUTCFullYear();
  return `INV-${year}-${String(installmentId).padStart(6, '0')}`;
}

/** Trace id for a single business operation (stored on payment rows). */
export function operationId() {
  return `op_${randomBytes(9).toString('hex')}`;
}

export function nowMs() {
  return Date.now();
}
