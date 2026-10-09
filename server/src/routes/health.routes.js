import { Router } from 'express';
import { checkDatabaseHealth } from '../db/client.js';
import { config } from '../config/index.js';
import { jobStatus } from '../jobs/scheduler.js';

const router = Router();
const startedAt = Date.now();

/**
 * GET /api/health
 * 200 when the database answers a trivial query, 503 otherwise (so Render marks
 * the instance unhealthy). Never includes the database URL, host or credentials.
 */
router.get('/', async (req, res) => {
  const database = await checkDatabaseHealth();
  const healthy = database.ok === true;
  const body = {
    status: healthy ? 'ok' : 'unhealthy',
    version: '1.0.0',
    env: config.nodeEnv,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timeZone: 'Asia/Dhaka',
    paymentProvider: config.payments.provider,
    jobs: jobStatus(),
    database: healthy
      ? { ok: true, provider: 'turso', latencyMs: database.latencyMs, foreignKeys: database.foreignKeys }
      : { ok: false, provider: 'turso', code: database.code ?? 'UNKNOWN', error: 'database unavailable' },
  };
  res.status(healthy ? 200 : 503).json({ data: body });
});

export default router;
