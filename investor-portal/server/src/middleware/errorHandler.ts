/**
 * Centralised error handling.
 *
 * Guarantees:
 *  - clients never receive stack traces, SQL, Prisma internals or gateway payloads
 *  - every 5xx is logged with the request id so support can correlate
 *  - expected/validation errors return the useful field-level detail
 */
import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '../generated/prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { isDatabaseSchemaError } from '../utils/database-errors';
import { logger } from '../utils/logger';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = String(req.id ?? 'unknown');
  let status = 500;
  let code = 'INTERNAL';
  let message = 'Something went wrong. Please try again or contact support.';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (isDatabaseSchemaError(err)) {
    // A missing table/column is a deployment migration problem, never a client
    // error. In particular, don't turn Prisma P2021 into HTTP 400 below.
    status = 503;
    code = 'SERVICE_UNAVAILABLE';
    message = 'The database schema is not initialized. Apply pending migrations before using the API.';
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      status = 409;
      code = 'CONFLICT';
      const target = (err.meta?.target as string[] | string | undefined) ?? 'field';
      message = `A record with the same ${Array.isArray(target) ? target.join(', ') : target} already exists`;
    } else if (err.code === 'P2025') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'Resource not found';
    } else if (err.code === 'P2003') {
      status = 409;
      code = 'CONFLICT';
      message = 'This record is referenced by other data and cannot be changed';
    } else {
      status = 400;
      code = 'BAD_REQUEST';
      message = 'The request could not be processed';
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid data supplied';
  } else if (err instanceof Prisma.PrismaClientInitializationError) {
    status = 503;
    code = 'SERVICE_UNAVAILABLE';
    message = 'Database temporarily unavailable';
  } else if (err instanceof Error && err.message === 'Not allowed by CORS') {
    // strict CORS: the browser origin is not on the allowlist
    status = 403;
    code = 'FORBIDDEN';
    message = 'Origin not allowed';
  } else if (isBodyParserError(err)) {
    status = (err as { status?: number }).status ?? 400;
    code = 'BAD_REQUEST';
    message = (err as Error).message;
  } else if (isMulterError(err)) {
    const multerCode = (err as { code: string }).code;
    status = multerCode === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = multerCode === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
    message =
      multerCode === 'LIMIT_FILE_SIZE'
        ? 'File is too large. The maximum size is 2 MB'
        : 'Upload rejected: check the file type and size (JPG/PNG, max 2 MB)';
  } else if (err instanceof Error && /payload too large|entity too large/i.test(err.message)) {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Uploaded file is too large';
  }

  const logPayload = {
    requestId,
    status,
    code,
    method: req.method,
    url: req.originalUrl,
    adminId: req.admin?.id,
    err:
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack, cause: (err as { cause?: unknown }).cause }
        : err,
  };

  if (status >= 500) {
    logger.error(logPayload, 'unhandled error');
  } else if (code !== 'VALIDATION_ERROR' && code !== 'NOT_FOUND') {
    logger.warn(logPayload, 'request rejected');
  }

  const body: ErrorBody = { error: { code, message, requestId } };
  if (details) body.error.details = details;
  res.status(status).json(body);
}

function isMulterError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'MulterError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

function isBodyParserError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof (err as { type?: unknown }).type === 'string' &&
    ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported'].includes((err as { type: string }).type)
  );
}

export default errorHandler;
