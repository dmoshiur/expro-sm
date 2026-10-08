/**
 * Raw upload handling for investor photos / NID scans.
 * The body is buffered in memory (small, bounded) and validated by magic bytes
 * in services/files.service.js. Nothing is ever written to a public folder.
 */
import express from 'express';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'application/octet-stream'];
const SCAN_TYPES = ['image/jpeg', 'image/png', 'application/pdf', 'application/octet-stream'];

export const photoUpload = express.raw({
  type: (req) => PHOTO_TYPES.includes(String(req.headers['content-type'] ?? '').split(';')[0].trim()),
  limit: Math.min(config.security.maxUploadBytes, 2 * 1024 * 1024) + 1024,
});

export const scanUpload = express.raw({
  type: (req) => SCAN_TYPES.includes(String(req.headers['content-type'] ?? '').split(';')[0].trim()),
  limit: 4 * 1024 * 1024 + 1024,
});

/** Runs after the raw parsers: guarantees a buffered, non-empty body. */
export function ensureRawBody(req, _res, next) {
  const ok = Buffer.isBuffer(req.body) && req.body.length > 0;
  if (!ok) {
    return next(
      new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as the raw request body (image/jpeg, image/png or application/pdf)'),
    );
  }
  return next();
}
