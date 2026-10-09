import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { checkDatabaseHealth } from '../db/client.js';
import { config } from '../config/index.js';
import { jobStatus } from '../jobs/scheduler.js';
import { CLIENT_DIST } from '../app.js';

const router = Router();
const startedAt = Date.now();

/**
 * GET /api/health
 * 200 when the database answers a trivial query, 503 otherwise (so Render marks
 * the instance unhealthy). Never includes the database URL, host or credentials.
 * Frontend build status is reported separately so that `database unavailable`
 * vs `frontend not built` vs `ok` can be distinguished without hiding 503.
 */
router.get('/', async (req, res) => {
  const database = await checkDatabaseHealth();
  const frontendBuilt = existsSync(join(CLIENT_DIST, 'index.html'));
  // DB must be ok for a healthy instance. Frontend status is reported
  // separately so that `database unavailable` vs `frontend not built` vs `ok`
  // can be distinguished. In production the process refuses to start without
  // a build, but during development the API remains healthy even when the
  // frontend hasn't been built yet (Vite dev server on :5173).
  const healthy = database.ok === true;
  const body = {
    status: healthy ? 'ok' : 'unhealthy',
    version: '1.0.0',
    env: config.nodeEnv,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timeZone: 'Asia/Dhaka',
    paymentProvider: config.payments.provider,
    smsProvider: config.sms.provider,
    jobs: jobStatus(),
    frontend: {
      built: frontendBuilt,
      dir: frontendBuilt ? undefined : CLIENT_DIST,
      error: frontendBuilt ? undefined : 'frontend not built – run npm run build',
    },
    database: database.ok
      ? { ok: true, provider: 'turso', latencyMs: database.latencyMs, foreignKeys: database.foreignKeys }
      : { ok: false, provider: 'turso', code: database.code ?? 'UNKNOWN', error: 'database unavailable' },
  };
  // Sanitize: don't leak full path when built (ok), only when missing for ops.
  if (frontendBuilt) delete body.frontend.dir;
  res.status(healthy ? 200 : 503).json({ data: body });
});

export default router;
