/**
 * Express application factory.
 *
 * One process, one port: this app serves the JSON API under /api, the public
 * payment-link callback under /pay and the built React SPA from client/dist.
 * No CORS is required in production because everything is same-origin.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { requestContext } from './middleware/context.js';
import { securityHeaders, sameOriginGuard, apiLimiter } from './middleware/security.js';
import { cookiesMiddleware } from './middleware/cookies.js';
import { attachSession } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import apiRoutes from './routes/index.js';
import { payCallbackRouter } from './routes/public.routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIST = resolve(HERE, '../../client/dist');

export function createApp({ serveStatic = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  // --- infrastructure middleware -------------------------------------------
  app.use(requestContext);
  app.use(securityHeaders);
  app.use(cookiesMiddleware);
  app.use(sameOriginGuard);

  // JSON for the API (uploads use their own raw parsers on the routes).
  app.use('/api', express.json({ limit: '512kb' }), express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(attachSession);
  app.use('/api', apiLimiter, apiRoutes);

  // Gateway redirect target (must stay on the root path, outside /api).
  app.use('/pay', payCallbackRouter);

  if (serveStatic) mountSpa(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function mountSpa(app) {
  const indexHtml = join(CLIENT_DIST, 'index.html');
  const hasBuild = existsSync(indexHtml);
  if (!hasBuild) {
    logger.warn('client build not found - run `npm run build` before `npm start` for the full app', { dir: CLIENT_DIST });
  }
  // Hashed assets are immutable; index.html must never be cached.
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      etag: true,
      maxAge: '1y',
      immutable: true,
      setHeaders(res, path) {
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (!req.accepts('html')) return next();
    if (!hasBuild) {
      return res
        .status(503)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>Investor Portal</title>' +
            '<body style="font-family:system-ui;padding:2rem;max-width:44rem;margin:auto">' +
            '<h1>Frontend not built yet</h1>' +
            '<p>Run <code>npm run build</code> (production) or <code>npm run dev</code> (development, Vite on :5173).</p>' +
            '<p>The API is available under <code>/api</code>.</p></body>',
        );
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(indexHtml);
  });
}

export { config, logger };
