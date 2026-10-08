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

/** Convert a Postgres error into a client-safe AppError. */
export function fromPgError(err) {
  if (!err || typeof err !== 'object') return new AppError(500, 'INTERNAL', 'Internal server error');
  if (err.code === '23505' || err.code === '23505' /* unique_violation */) {
    return conflict('A record with these details already exists', { constraint: err.constraint });
  }
  if (err.code === '23503') return badRequest('Referenced record does not exist', { constraint: err.constraint });
  if (err.code === '23514') return badRequest('Value violates a data constraint', { constraint: err.constraint });
  if (err.code === '23502') return badRequest('A required field is missing', { column: err.column });
  if (err.code === '22001') return badRequest('Value is too long');
  if (err.code === 'P0001') return badRequest(err.message || 'Operation rejected by a database rule');
  return new AppError(500, 'INTERNAL', 'Internal server error');
}
