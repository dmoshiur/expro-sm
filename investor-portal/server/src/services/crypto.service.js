/**
 * Cryptography implemented with node:crypto only.
 *   - passwords      : scrypt + per-password random salt, constant-time compare
 *   - sensitive data : AES-256-GCM (authenticated) with a random IV per record
 *   - blind indexes  : HMAC-SHA256 (exact search / duplicate detection)
 *   - TOTP           : RFC 6238 (HMAC-SHA1, 30s step, 6 digits) + otpauth URI
 *   - tokens         : random 256-bit base64url, stored only as SHA-256
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';

const scrypt = promisify(scryptCb);

// ---------------------------------------------------------------------------
// Passwords (scrypt)
// ---------------------------------------------------------------------------
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Returns `scrypt$N$r$p$saltHex$hashHex` (self-describing, upgrade-friendly). */
export async function hashPassword(password, params = SCRYPT) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new AppError(400, 'WEAK_PASSWORD', 'Password must be at least 12 characters');
  }
  const salt = randomBytes(params.saltBytes);
  const derived = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Cheap password policy shared by create/change-password paths. */
export function assertPasswordPolicy(password, { email, name } = {}) {
  const missing = [];
  const forbidden = [];
  const value = typeof password === 'string' ? password : '';
  if (value.length < 12) missing.push('at least 12 characters');
  if (value.length > 200) missing.push('at most 200 characters');
  if (value && !/[a-z]/.test(value)) missing.push('a lowercase letter');
  if (value && !/[A-Z]/.test(value)) missing.push('an uppercase letter');
  if (value && !/\d/.test(value)) missing.push('a digit');
  if (value && !/[^A-Za-z0-9]/.test(value)) missing.push('a symbol');

  const lower = value.toLowerCase();
  const emailLocal = email ? String(email).split('@')[0].toLowerCase() : null;
  if (emailLocal && emailLocal.length >= 4 && lower.includes(emailLocal)) forbidden.push('your email name');
  if (name && String(name).trim().length >= 4 && lower.includes(String(name).trim().toLowerCase())) {
    forbidden.push('your name');
  }
  if (/^(password|admin|qwerty|12345)/i.test(value)) forbidden.push('a common password prefix');

  if (missing.length || forbidden.length) {
    const parts = [];
    if (missing.length) parts.push(`it must contain ${missing.join(', ')}`);
    if (forbidden.length) parts.push(`it must not contain ${forbidden.join(' or ')}`);
    throw new AppError(422, 'WEAK_PASSWORD', `Password is not strong enough: ${parts.join('; ')}.`, {
      missing,
      forbidden,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// AES-256-GCM field encryption
// ---------------------------------------------------------------------------
const ENC_VERSION = 'v1';

function encryptionKey() {
  const key = config.security.encryptionKey;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new AppError(500, 'CONFIG', 'ENCRYPTION_KEY is missing or malformed');
  }
  return Buffer.from(key, 'hex');
}

/** Encrypt a UTF-8 string or Buffer -> `v1.<ivB64url>.<tagB64url>.<ctB64url>`. */
export function encryptField(plaintext, { aad } = {}) {
  if (plaintext === null || plaintext === undefined) return null;
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv, { authTagLength: 16 });
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

/** Decrypt ciphertext produced by encryptField. Returns string unless asBuffer. */
export function decryptField(payload, { aad, asBuffer = false } = {}) {
  if (payload === null || payload === undefined) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== ENC_VERSION) {
    throw new AppError(500, 'DECRYPT_FAILED', 'Stored value is not decryptable (bad format)');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64url'), {
      authTagLength: 16,
    });
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const out = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
    return asBuffer ? out : out.toString('utf8');
  } catch {
    // Never leak whether it was padding/tag/format: single generic failure.
    throw new AppError(500, 'DECRYPT_FAILED', 'Stored value could not be decrypted');
  }
}

export function encryptBuffer(buf, opts) {
  return encryptField(buf, opts);
}
export function decryptBuffer(payload, opts) {
  return decryptField(payload, { ...opts, asBuffer: true });
}

// ---------------------------------------------------------------------------
// Blind index (HMAC-SHA256, key derived from ENCRYPTION_KEY with a label)
// ---------------------------------------------------------------------------
export function blindIndex(value, label = 'default') {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const key = createHmac('sha256', encryptionKey()).update(`blind-index:${label}`).digest();
  return createHmac('sha256', key).update(String(value).trim().toUpperCase()).digest('hex');
}

export const nidHash = (nid) => blindIndex(nid, 'nid');
export const last4 = (value) => (value ? String(value).replace(/\D/g, '').slice(-4) : null);

// ---------------------------------------------------------------------------
// Tokens / session ids
// ---------------------------------------------------------------------------
export function generateSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function signHmac(payload, secret = config.security.sessionSecret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function verifyHmac(payload, signature, secret = config.security.sessionSecret) {
  const expected = Buffer.from(signHmac(payload, secret));
  const given = Buffer.from(String(signature ?? ''));
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238 / RFC 4648 base32)
// ---------------------------------------------------------------------------
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP = { digits: 6, period: 30, algorithm: 'sha1', secretBytes: 20 };

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = B32_ALPHABET.indexOf(char);
    if (idx === -1) throw new AppError(400, 'BAD_SECRET', 'Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = TOTP.secretBytes) {
  return base32Encode(randomBytes(bytes));
}

function hotp(secretBuffer, counter, digits = TOTP.digits) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(TOTP.algorithm, secretBuffer).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpStep(instantMs = Date.now(), period = TOTP.period) {
  return Math.floor(instantMs / 1000 / period);
}

/** Current TOTP code for a base32 secret (used by tests and the setup screen). */
export function generateTotp(secret, { instantMs = Date.now(), period = TOTP.period, digits = TOTP.digits } = {}) {
  return hotp(base32Decode(secret), totpStep(instantMs, period), digits);
}

/**
 * Verify a submitted code with +/- `window` steps of clock drift.
 * Returns { ok, step } - the caller persists `step` to block replay.
 */
export function verifyTotp(secret, token, { window = config.totp.window, instantMs = Date.now(), period = TOTP.period, digits = TOTP.digits, lastStep = null } = {}) {
  const code = String(token ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return { ok: false, step: null };
  const secretBuffer = base32Decode(secret);
  const current = totpStep(instantMs, period);
  let matched = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    const candidate = hotp(secretBuffer, step, digits);
    const a = Buffer.from(candidate);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      matched = step;
      break;
    }
  }
  if (matched === null) return { ok: false, step: null };
  if (lastStep !== null && matched <= Number(lastStep)) return { ok: false, step: matched, replayed: true };
  return { ok: true, step: matched };
}

/** otpauth:// URI (manual entry + third-party authenticator apps). */
export function totpUri(secret, { account, issuer = config.totp.issuer } = {}) {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: TOTP.algorithm.toUpperCase(),
    digits: String(TOTP.digits),
    period: String(TOTP.period),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account ?? 'admin')}?${params.toString()}`;
}

/** Human-readable grouping for manual entry: ABCD EFGH IJKL ... */
export function groupSecret(secret, size = 4) {
  return String(secret).replace(/(.{4})/g, '$1 ').trim();
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export function randomDigits(length = 6) {
  return Array.from(randomBytes(length))
    .map((b) => String(b % 10))
    .join('');
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
