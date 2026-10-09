/**
 * Upload validation for investor photos and NID scans.
 *
 * Files are stored in the database (BYTEA) - never in a public folder, never
 * served statically. NID scans are additionally encrypted with AES-256-GCM and
 * only ever decrypted for SUPER_ADMIN requests (which are audited).
 *
 * Validation is by MAGIC BYTES, not by extension or declared content type.
 */
import { config } from '../config/index.js';
import { badRequest } from '../utils/errors.js';
import { decryptBuffer, encryptBuffer } from './crypto.service.js';

export const IMAGE_TYPES = {
  jpg: { mime: 'image/jpeg', ext: 'jpg', signature: [0xff, 0xd8, 0xff] },
  png: { mime: 'image/png', ext: 'png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
};

export const SCAN_TYPES = {
  ...IMAGE_TYPES,
  pdf: { mime: 'application/pdf', ext: 'pdf', signature: [0x25, 0x50, 0x44, 0x46] }, // %PDF
};

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB (spec)
export const SCAN_MAX_BYTES = 4 * 1024 * 1024;

function matchesSignature(buffer, signature) {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

export function detectType(buffer, catalogue) {
  for (const [key, def] of Object.entries(catalogue)) {
    if (matchesSignature(buffer, def.signature)) return { key, ...def };
  }
  return null;
}

/** Extra structural checks that go beyond the magic bytes. */
function validateImageStructure(buffer, type) {
  if (type === 'png') {
    const iend = buffer.lastIndexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])); // IEND
    if (iend < 0) throw badRequest('PNG file appears to be truncated or corrupted');
    return;
  }
  if (type === 'jpg') {
    const eoi = buffer.lastIndexOf(Buffer.from([0xff, 0xd9])); // EOI
    if (eoi < 0) throw badRequest('JPEG file appears to be truncated or corrupted');
  }
}

/**
 * Validates an uploaded file buffer.
 * Returns { buffer, mime, ext, type, size }.
 */
export function validateUpload(buffer, { kind = 'photo' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badRequest('No file data received');
  const catalogue = kind === 'photo' ? IMAGE_TYPES : SCAN_TYPES;
  const maxBytes = kind === 'photo' ? Math.min(PHOTO_MAX_BYTES, config.security.maxUploadBytes) : SCAN_MAX_BYTES;
  if (buffer.length > maxBytes) {
    throw badRequest(`File is too large. Maximum ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`);
  }
  const detected = detectType(buffer, catalogue);
  if (!detected) {
    const allowed = Object.values(catalogue).map((t) => t.mime).join(', ');
    throw badRequest(`Unsupported file type. Allowed: ${allowed} (verified by file signature)`);
  }
  if (detected.key !== 'pdf') validateImageStructure(buffer, detected.key);
  return { buffer, mime: detected.mime, ext: detected.ext, type: detected.key, size: buffer.length };
}

/**
 * NID scans live encrypted in the DB. AAD binds the ciphertext to the investor
 * row so a copy-pasted blob cannot be replayed onto another investor.
 */
export function encryptScan(buffer, investorId) {
  return encryptBuffer(buffer, { aad: `investor:${investorId}:nid_scan` });
}

export function decryptScan(payload, investorId) {
  return decryptBuffer(payload, { aad: `investor:${investorId}:nid_scan` });
}

export function safeMimeForResponse(mime) {
  const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
  return allowed.includes(mime) ? mime : 'application/octet-stream';
}
