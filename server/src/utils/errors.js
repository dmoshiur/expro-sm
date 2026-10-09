/** Application error type + helpers. Never leak internals to clients. */

export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (msg = 'Invalid request', details) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg = 'Conflict', details) => new AppError(409, 'CONFLICT', msg, details);
export const gone = (msg = 'Gone') => new AppError(410, 'GONE', msg);
export const unprocessable = (msg = 'Validation failed', details) => new AppError(422, 'VALIDATION_ERROR', msg, details);
export const tooMany = (msg = 'Too many requests, please try again later') => new AppError(429, 'RATE_LIMITED', msg);
export const serviceUnavailable = (msg = 'Service temporarily unavailable') => new AppError(503, 'SERVICE_UNAVAILABLE', msg);
export const badGateway = (msg = 'Upstream provider error') => new AppError(502, 'UPSTREAM_ERROR', msg);

export function isAppError(err) {
  return err instanceof AppError || (err && typeof err.status === 'number' && typeof err.code === 'string');
}

/**
 * Convert a database error (DbError from db/errors.js) into a client-safe AppError.
 * Returns null for anything that is not a database error. Messages come from our own
 * constraint names or RAISE() texts only - never SQL text or connection details.
 */
export function fromDbError(err) {
  if (!err || typeof err !== 'object' || err.name !== 'DbError') return null;
  switch (err.code) {
    case 'UNIQUE_VIOLATION':
      return conflict('A record with these details already exists', { constraint: err.constraint ?? undefined });
    case 'FOREIGN_KEY_VIOLATION':
      return badRequest('Referenced record does not exist');
    case 'NOT_NULL_VIOLATION':
      return badRequest('A required field is missing');
    case 'CHECK_VIOLATION':
      return badRequest('Value violates a data constraint');
    case 'RAISED':
      return badRequest(err.message || 'Operation rejected by a database rule');
    case 'DB_BUSY':
      return serviceUnavailable('Database is busy, please retry');
    case 'DB_UNAVAILABLE':
      return serviceUnavailable('Database is temporarily unavailable');
    default:
      return new AppError(500, 'INTERNAL', 'Internal server error');
  }
}
