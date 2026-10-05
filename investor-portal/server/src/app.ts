/**
 * Express application factory.
 *
 * Security defaults baked in here:
 *  - helmet with a strict policy (this is a JSON API, the SPA is served by Nginx)
 *  - CORS restricted to the configured origins, credentials enabled
 *  - JSON body limit, cookie parsing, request ids, structured logs
 *  - rate limits on the whole API plus tighter limits on auth/public routes
 *  - a central error handler that never leaks internals
 */
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import cookieParser from 'cookie-parser';
import { config, configProblems } from './config';
import type { ConfigProblem } from './config/production';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { requestLogger } from './middleware/requestLogger';
import { apiRouter } from './routes';
import { isOriginAllowed } from './utils/origin';
import { logger } from './utils/logger';

export interface CreateAppOptions {
  /** Override for tests; defaults to the problems detected from the environment. */
  configProblems?: readonly ConfigProblem[];
}

export function createApp(options: CreateAppOptions = {}): Express {
  const problems = options.configProblems ?? configProblems;
  // Only `core` problems stop the API: a missing Cloudinary key or bKash
  // credential disables that feature (it fails closed where it is used) instead
  // of taking login and reporting down with it.
  const blockingProblems = problems.filter((problem) => problem.scope === 'core');

  if (blockingProblems.length > 0) {
    // Log once per cold start; the same list is returned by the 503 gate below.
    logger.error(
      { problems: problems.map((problem) => `[${problem.scope}] ${problem.message}`) },
      'the API is not fully configured - requests will receive HTTP 503 until this is fixed',
    );
  }

  const app = express();

  // Behind Nginx / a load balancer we need the real client IP for rate limits
  // and for the audit trail. 1 = trust the first proxy hop.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
      frameguard: { action: 'deny' },
      noSniff: true,
    }),
  );

  const corsOptions: CorsOptions = {
    // Strict allowlist (exact origins, plus optional single-label wildcards such
    // as https://*.example.com for ephemeral dev/preview hosts). Requests without
    // an Origin (server-to-server, curl, gateway webhooks) are allowed because
    // they cannot be CSRF'd by a browser.
    origin(origin, callback) {
      if (isOriginAllowed(origin, config.corsOrigins)) {
        callback(null, true);
        return;
      }
      logger.warn({ origin, allowed: config.corsOrigins.length }, 'blocked by CORS');
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestId);
  app.use(requestLogger);

  // Configuration gate: a deployment that is missing core settings answers every
  // request with 503 + the exact list, instead of crashing the whole function
  // (500 FUNCTION_INVOCATION_FAILED) on every route, including /health.
  if (blockingProblems.length > 0) {
    app.use((req, res) => {
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The API is not fully configured on this deployment. The administrator must provide the settings listed in details.problems.',
          details: {
            problems: problems.map((problem) => problem.message),
            scopes: [...new Set(problems.map((problem) => problem.scope))],
          },
          requestId: String(req.id ?? 'unknown'),
        },
      });
    });
  }

  // Cheap health probe (no DB access) for PM2 / Nginx / uptime monitors.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'investor-portal-api', env: config.env, time: new Date().toISOString() });
  });

  app.use('/api', apiLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
