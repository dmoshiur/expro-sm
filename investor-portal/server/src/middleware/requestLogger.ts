import crypto from 'node:crypto';
import pinoHttp from 'pino-http';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * HTTP access log. Sensitive headers are redacted (see utils/logger.ts).
 * Health checks and static assets are not logged to keep noise down.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req: Request) => (req.id as string | undefined) ?? crypto.randomUUID(),
  autoLogging: {
    ignore: (req: { url?: string }) => {
      const url = req.url ?? '';
      return url.startsWith('/health') || url === '/favicon.ico';
    },
  },
  customLogLevel: (_req: unknown, res: Response, err?: Error) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req: Request, res: Response) => `${req.method} ${req.url} ${res.statusCode}`,
  serializers: {
    req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url }),
    res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
  },
  enabled: !config.isTest,
} as never);

export function securityHeadersLogging(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
