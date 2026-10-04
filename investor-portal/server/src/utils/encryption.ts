/**
 * Symmetric encryption for data at rest (NID numbers, TOTP secrets).
 * AES-256-GCM with a random 96-bit IV per value and the auth tag stored
 * alongside the ciphertext.
 *
 * Wire format:  v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
 * The 32-byte key is derived from ENCRYPTION_KEY with scrypt, so operators can
 * supply a passphrase or a raw hex/base64 key without breaking the crypto.
 */
import crypto from 'node:crypto';
import { config } from '../config';

const KEY_SALT = 'investor-portal:aes-256-gcm:v1';
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(config.auth.encryptionKey, KEY_SALT, 32);
  }
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed ciphertext');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Returns null instead of throwing for corrupted/legacy values. */
export function decryptSafe(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/** Deterministic HMAC used for NID uniqueness + lookup without decryption. */
export function hmac(value: string): string {
  return crypto.createHmac('sha256', config.auth.nidHashPepper).update(value.trim()).digest('hex');
}

/** SHA-256 hex digest (used for payment-link tokens and refresh tokens). */
export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Cryptographically strong URL-safe token (default 32 bytes => 43 chars). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison to avoid timing side channels. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ----------------------------- masking -------------------------------------

/** 01712345678 -> 01712****78 (used in logs and for low-privilege roles) */
export function maskMobile(mobile: string | null | undefined): string {
  if (!mobile) return '';
  const digits = mobile.replace(/\s/g, '');
  if (digits.length <= 6) return '******';
  return `${digits.slice(0, 5)}****${digits.slice(-2)}`;
}

/** 1234567890123 -> *******0123 */
export function maskNid(nid: string | null | undefined): string {
  if (!nid) return '';
  if (nid.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, nid.length - 4))}${nid.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  const head = user.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`;
}
