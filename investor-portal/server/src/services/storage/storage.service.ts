/**
 * File storage adapter.
 *
 * The application only ever stores the `publicId` of an asset in the database;
 * the bytes live in the configured backend.
 *
 *   cloudinary : production backend. Profile photos use a public, optimised
 *                delivery URL; NID scans are uploaded as *authenticated*
 *                (private) assets and are only reachable through a short lived
 *                signed URL generated per request.
 *   local      : development / air-gapped fallback (and the test suite). Files
 *                are written to server/local-storage and served through
 *                tokenised, expiring URLs handled by this server.
 *
 * Selecting: STORAGE_DRIVER=auto (default) uses Cloudinary when credentials are
 * present, otherwise local.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../../config';
import { badRequest } from '../../utils/errors';
import { logger } from '../../utils/logger';

export type AssetVisibility = 'public' | 'private';

export interface UploadInput {
  buffer: Buffer;
  mimetype: string;
  originalName: string;
  folder: string;
  visibility: AssetVisibility;
}

export interface UploadedAsset {
  publicId: string;
  url: string | null;
  visibility: AssetVisibility;
  bytes: number;
  format: string;
  driver: StorageDriver;
}

export interface PrintUrlOptions {
  /** seconds until the signed URL expires */
  ttlSeconds?: number;
  /** force a download with this filename */
  attachmentName?: string;
  /** image transformation (Cloudinary) - e.g. width for a thumbnail */
  width?: number;
}

export type StorageDriver = 'cloudinary' | 'local';

export interface StorageAdapter {
  readonly driver: StorageDriver;
  upload(input: UploadInput): Promise<UploadedAsset>;
  destroy(publicId: string, visibility?: AssetVisibility): Promise<void>;
  /** Short-lived URL for a private asset; null when the adapter has none. */
  signedUrl(publicId: string, options?: PrintUrlOptions): string | null;
}

// ---------------------------------------------------------------------------
// validation shared by every driver (the server enforces it, never the client)
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/jpg', 'image/png'] as const;

export function assertValidImage(file: { mimetype: string; size: number; originalname: string }): void {
  if (!ALLOWED_IMAGE_MIME.includes(file.mimetype as (typeof ALLOWED_IMAGE_MIME)[number])) {
    throw badRequest('Only JPG and PNG files are allowed');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw badRequest('File is too large. The maximum size is 2 MB');
  }
  if (!/\.(jpe?g|png)$/i.test(file.originalname)) {
    throw badRequest('Only .jpg, .jpeg and .png files are allowed');
  }
}

// ---------------------------------------------------------------------------
// Cloudinary
// ---------------------------------------------------------------------------

export function createCloudinaryAdapter(): StorageAdapter {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true,
  });

  const root = config.cloudinary.folder;

  return {
    driver: 'cloudinary',
    async upload(input) {
      assertValidImage({ mimetype: input.mimetype, size: input.buffer.byteLength, originalname: input.originalName });
      const isPrivate = input.visibility === 'private';
      const result = await new Promise<{ public_id: string; secure_url: string; bytes: number; format: string }>(
        (resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: `${root}/${input.folder}`,
              resource_type: 'image',
              type: isPrivate ? 'authenticated' : 'upload',
              overwrite: false,
              // strip metadata (GDPR / NID scans should not carry EXIF)
              image_metadata: false,
              transformation: isPrivate ? undefined : [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
            },
            (error, uploaded) => {
              if (error || !uploaded) {
                reject(error ?? new Error('Cloudinary upload failed'));
                return;
              }
              resolve(uploaded as { public_id: string; secure_url: string; bytes: number; format: string });
            },
          );
          stream.end(input.buffer);
        },
      );

      return {
        publicId: result.public_id,
        url: isPrivate ? null : result.secure_url,
        visibility: input.visibility,
        bytes: result.bytes,
        format: result.format,
        driver: 'cloudinary',
      };
    },

    async destroy(publicId) {
      try {
        // try the private namespace first, then the public one
        const privateResult = await cloudinary.uploader.destroy(publicId, { type: 'authenticated', invalidate: true });
        if (privateResult.result !== 'ok') {
          await cloudinary.uploader.destroy(publicId, { invalidate: true });
        }
      } catch (error) {
        logger.warn({ err: error, publicId }, 'failed to delete cloudinary asset');
      }
    },

    signedUrl(publicId, options) {
      const ttl = options?.ttlSeconds ?? config.cloudinary.signedUrlTtl;
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      const transformation = options?.width ? `w_${options.width},c_limit,q_auto` : 'q_auto';
      const flags = options?.attachmentName ? `fl_attachment:${encodeURIComponent(options.attachmentName)}` : 'fl_attachment';
      // authenticated delivery with a time limited signature
      return cloudinary.utils.private_download_url(
        publicId,
        'jpg',
        {
          resource_type: 'image',
          type: 'authenticated',
          expires_at: expiresAt,
          attachment: Boolean(options?.attachmentName),
          transformation,
          flags,
        } as never,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Local filesystem (development / tests / air-gapped deployments)
// ---------------------------------------------------------------------------

const LOCAL_ROOT = path.resolve(process.cwd(), config.storage.localDir);

function signLocal(publicId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', config.auth.encryptionKey)
    .update(`${publicId}:${expiresAt}`)
    .digest('base64url');
}

export const localFilePath = (publicId: string): string => path.join(LOCAL_ROOT, publicId);

export function createLocalAdapter(): StorageAdapter {
  return {
    driver: 'local',
    async upload(input) {
      assertValidImage({ mimetype: input.mimetype, size: input.buffer.byteLength, originalname: input.originalName });
      const extension = input.mimetype === 'image/png' ? 'png' : 'jpg';
      const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
      const publicId = path.posix.join(input.folder, fileName);
      const target = localFilePath(publicId);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.buffer);
      return {
        publicId,
        url: `/api/files/local/${publicId}`,
        visibility: input.visibility,
        bytes: input.buffer.byteLength,
        format: extension,
        driver: 'local',
      };
    },
    async destroy(publicId) {
      await fs.rm(localFilePath(publicId), { force: true }).catch(() => undefined);
    },
    signedUrl(publicId, options) {
      const ttl = options?.ttlSeconds ?? config.cloudinary.signedUrlTtl;
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      const signature = signLocal(publicId, expiresAt);
      const query = new URLSearchParams({ exp: String(expiresAt), sig: signature });
      if (options?.attachmentName) query.set('download', options.attachmentName);
      return `/api/files/local/${publicId}?${query.toString()}`;
    },
  };
}

/** Verifies a signed local URL (used by the file route). */
export function verifyLocalSignature(publicId: string, expiresAt: number, signature: string): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  const expected = signLocal(publicId, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// adapter selection
// ---------------------------------------------------------------------------

let adapter: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (adapter) return adapter;
  const driver = config.storage.driver;
  if (driver === 'cloudinary' || (driver === 'auto' && config.cloudinary.enabled)) {
    if (!config.cloudinary.enabled) {
      throw new Error('STORAGE_DRIVER=cloudinary requires CLOUDINARY_* environment variables');
    }
    adapter = createCloudinaryAdapter();
  } else {
    if (driver === 'auto') logger.warn('Cloudinary not configured - using local file storage');
    adapter = createLocalAdapter();
  }
  return adapter;
}

/** Test helper: replaces the adapter (undefined restores auto-detection). */
export function setStorage(next: StorageAdapter | null): void {
  adapter = next;
}

export const storageService = { getStorage, setStorage, assertValidImage, MAX_UPLOAD_BYTES, ALLOWED_IMAGE_MIME };
export default storageService;
