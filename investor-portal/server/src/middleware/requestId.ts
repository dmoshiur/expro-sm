import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Assigns every request a correlation id (honours an inbound X-Request-Id so
 * logs can be stitched across the proxy) and echoes it back to the client.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const id = typeof inbound === 'string' && /^[\w-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export default requestId;
