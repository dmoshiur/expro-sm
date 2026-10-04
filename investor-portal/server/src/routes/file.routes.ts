import { Router } from 'express';
import fs from 'node:fs';
import { localFilePath, verifyLocalSignature } from '../services/storage/storage.service';
import { getStorage } from '../services/storage/storage.service';
import { asyncHandler } from '../utils/asyncHandler';
import { notFound } from '../utils/errors';

/**
 * Serves files written by the LOCAL storage adapter (development / air-gapped
 * deployments). Access requires an HMAC signature with an expiry, issued by
 * `GET /api/investors/:id/nid-scan-url`. Public assets (profile photos) can be
 * fetched with the same signature scheme.
 *
 * In production the storage driver is Cloudinary and these routes return 404.
 */
export const fileRouter = Router();

fileRouter.get(
  '/local/*',
  asyncHandler(async (req, res) => {
    if (getStorage().driver !== 'local') throw notFound();

    const publicId = decodeURIComponent((req.params as Record<string, string>)['0'] ?? '');
    if (!publicId || publicId.includes('..')) throw notFound();

    const { exp, sig, download } = req.query as { exp?: string; sig?: string; download?: string };
    if (!exp || !sig || !verifyLocalSignature(publicId, Number(exp), sig)) throw notFound();

    const filePath = localFilePath(publicId);
    if (!fs.existsSync(filePath)) throw notFound();

    if (download) res.setHeader('Content-Disposition', `attachment; filename="${download.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(filePath);
  }),
);

export default fileRouter;
