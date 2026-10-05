/**
 * Application error types.
 *
 * Every error that reaches the client is normalised by the central error
 * handler. Internal details (stack traces, driver messages, gateway payloads)
 * are ALWAYS logged server-side and NEVER returned to the caller.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'PAYMENT_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: FieldIssue[];
  /** true => already logged with full context, error handler should not re-log the stack */
  public readonly expected: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: { details?: FieldIssue[]; cause?: unknown; expected?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expected = options.expected ?? statusCode < 500;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message = 'Bad request', details?: FieldIssue[]) =>
  new AppError(400, 'BAD_REQUEST', message, { details });

export const validationError = (message = 'Validation failed', details?: FieldIssue[]) =>
  new AppError(400, 'VALIDATION_ERROR', message, { details });

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Resource already exists') => new AppError(409, 'CONFLICT', message);

export const unprocessable = (message = 'Unprocessable request', details?: FieldIssue[]) =>
  new AppError(422, 'UNPROCESSABLE', message, { details });

export const rateLimited = (message = 'Too many requests, please try again later') =>
  new AppError(429, 'RATE_LIMITED', message);

export const paymentError = (message = 'Payment could not be completed') =>
  new AppError(402, 'PAYMENT_ERROR', message);

export const serviceUnavailable = (message = 'Service temporarily unavailable') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);

export const internal = (message = 'Something went wrong', cause?: unknown) =>
  new AppError(500, 'INTERNAL', message, { cause, expected: false });

/** Prisma "record not found" helper for readable service code. */
export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(404, 'NOT_FOUND', `${entity} not found`);
    this.name = 'NotFoundError';
  }
}
