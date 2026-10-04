/**
 * Multipart upload handling.
 *
 * Files are held in memory (max 2 MB, validated by type AND extension) and then
 * streamed to the storage adapter. Nothing is ever written to disk by this
 * process except through the local storage adapter.
 */
import multer from 'multer';
import type { RequestHandler } from 'express';
import { ALLOWED_IMAGE_MIME, MAX_UPLOAD_BYTES } from '../services/storage/storage.service';
import { AppError } from '../utils/errors';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_IMAGE_MIME.includes(file.mimetype as (typeof ALLOWED_IMAGE_MIME)[number])) {
      callback(new AppError(400, 'VALIDATION_ERROR', 'Only JPG and PNG images are allowed'));
      return;
    }
    if (!/\.(jpe?g|png)$/i.test(file.originalname)) {
      callback(new AppError(400, 'VALIDATION_ERROR', 'Only .jpg, .jpeg and .png files are allowed'));
      return;
    }
    callback(null, true);
  },
});

/** Single file field, e.g. `photo` or `nidScan`. */
export const singleFile = (field: string): RequestHandler => upload.single(field);

/** Optional file: multipart without the field is fine. */
export const optionalFile = (field: string): RequestHandler => (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    next();
    return;
  }
  singleFile(field)(req, res, next);
};

export default upload;
