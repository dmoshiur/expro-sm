import { Router } from 'express';
import { query } from '../db/pool.js';
import { ok } from '../utils/http.js';
import { config } from '../config/index.js';
import { jobStatus } from '../jobs/scheduler.js';

const router = Router();
const startedAt = Date.now();

router.get('/', async (req, res) => {
  let db = { ok: false };
  try {
    const res2 = await query('select now() as now, current_database() as db');
    db = { ok: true, now: res2.rows[0].now, name: res2.rows[0].db };
  } catch (err) {
    db = { ok: false, error: 'database unavailable' };
  }
  return ok(res, {
    status: db.ok ? 'ok' : 'degraded',
    version: '1.0.0',
    env: config.nodeEnv,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timeZone: 'Asia/Dhaka',
    paymentProvider: config.payments.provider,
    jobs: jobStatus(),
    database: db,
  });
});

export default router;
