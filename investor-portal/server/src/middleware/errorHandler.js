/**
 * Central error handling. Clients get { error: { code, message, details } }
 * plus the request id - never a stack trace, SQL text or provider payload.
 */
import { config } from '../config/index.js';
import { AppError, isAppError, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res, next) {
  next(notFound(`Route not found: ${req.method} ${req.path}`));
}

export function errorHandler(err, req, res, _next) {
  const requestId = req?.id ?? null;
  let status = err?.status ?? err?.statusCode ?? 500;
  let code = err?.code ?? 'INTERNAL';
  let message = err?.message ?? 'Internal server error';
  let details = err?.details;

  if (!isAppError(err)) {
    // Unknown/unexpected: log fully, answer generically.
    logger.error('unhandled error', { err, reqId: requestId, path: req?.path, method: req?.method });
    status = 500;
    code = 'INTERNAL';
    message = 'Something went wrong. Please try again.';
    details = undefined;
  } else if (status >= 500) {
    logger.error('application error', { err, reqId: requestId, path: req?.path, method: req?.method, code });
  }

  // Body parser / payload issues
  if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'The uploaded file or request body is too large';
  }
  if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = 'Request body is not valid JSON';
  }

  if (res.headersSent) return;
  if (req?.accepts?.('html') && !req?.path?.startsWith('/api') && !req?.xhr) {
    // Very small HTML fallback for direct browser navigation to a failing route.
    res.status(status).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Error</title>` +
        `<body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto">` +
        `<h1>${status}</h1><p>${escapeHtml(message)}</p>` +
        `<p style="color:#666;font-size:.8rem">Reference: ${escapeHtml(String(requestId ?? ''))}</p></body>`,
    );
    return;
  }

  const payload = { error: { code, message, requestId } };
  if (details && !config.isProd) payload.error.details = details;
  else if (details && status < 500) payload.error.details = details;
  res.status(status).json(payload);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Guard: only these content types may reach JSON body parsing (uploads use raw). */
export function requireJson(req, _res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.is('application/json') === false && !req.is('multipart/form-data')) {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
  }
  return next();
}

export function requireAdminApi(req, _res, next) {
  return next();
}
