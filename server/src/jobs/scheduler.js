/**
 * In-process job scheduler. No cron, no queue, no extra service.
 *
 * How it stays safe:
 *   * a single 30s tick inspects the Asia/Dhaka clock
 *   * every job has a deterministic run_key (a Dhaka date, or a date+window for
 *     interval jobs) recorded in job_runs with a UNIQUE constraint, so a run is
 *     executed exactly once per key - including across restarts
 *   * when the process was down at the scheduled minute, the job still runs on
 *     the next tick (catch-up), because the check is "has this key run?" and
 *     not "is it exactly 00:10?"
 *   * a job never crashes the server: failures are logged, recorded and retried
 *     on the next tick; stale STARTED rows are cleared at boot
 */
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { dhakaDate, dhakaMinutesOfDay, parseHHMM } from '../utils/dates.js';
import * as audit from '../services/audit.service.js';
import { runOverdueJob } from './overdue.job.js';
import { runRemindersJob } from './reminders.job.js';
import { runReconcileJob } from './reconcile.job.js';
import { runHousekeepingJob } from './housekeeping.job.js';

const TICK_MS = 30_000;
const STALE_RUN_MINUTES = 30;

const JOBS = new Map();
let timer = null;
let ticking = false;
const running = new Set();
const lastTick = { at: null, dhakaDate: null, minutes: null };

/** Register a job: { name, schedule: { type: 'daily', at: 'HH:MM' } | { type:'interval', everyMinutes }, runKey(), handler() } */
export function defineJob(definition) {
  JOBS.set(definition.name, definition);
  return definition;
}

export function registerDefaultJobs() {
  if (JOBS.size > 0) return;
  defineJob({
    name: 'installments.overdue',
    description: 'Mark past-due installments as OVERDUE (Asia/Dhaka midnight sweep)',
    schedule: { type: 'daily', at: config.jobs.overdueAt },
    runKey: () => `daily-${dhakaDate()}`,
    handler: runOverdueJob,
  });
  defineJob({
    name: 'reminders.sms',
    description: 'SMS reminders for installments due soon and overdue',
    schedule: { type: 'daily', at: config.jobs.remindersAt },
    runKey: () => `daily-${dhakaDate()}`,
    handler: runRemindersJob,
  });
  defineJob({
    name: 'payments.reconcile',
    description: 'Re-query stuck INITIATED/PENDING payments with the gateway',
    schedule: { type: 'interval', everyMinutes: config.jobs.reconcileEveryMinutes },
    runKey: () => {
      const window = Math.floor(dhakaMinutesOfDay() / Math.max(1, config.jobs.reconcileEveryMinutes));
      return `w-${dhakaDate()}-${window}`;
    },
    handler: runReconcileJob,
  });
  defineJob({
    name: 'housekeeping',
    description: 'Abandoned payments, expired sessions cleanup',
    schedule: { type: 'daily', at: '03:15' },
    runKey: () => `daily-${dhakaDate()}`,
    handler: runHousekeepingJob,
  });
}

function isDue(job, now = new Date()) {
  const minutes = dhakaMinutesOfDay(now);
  if (job.schedule.type === 'interval') {
    const window = Math.floor(minutes / Math.max(1, job.schedule.everyMinutes));
    return { due: true, key: job.runKey(), window };
  }
  const target = parseHHMM(job.schedule.at);
  return { due: minutes >= target, key: job.runKey(), target };
}

/**
 * Run a job under the run_key lock. Safe to call concurrently: the unique
 * constraint on (job_name, run_key) decides who wins.
 */
export async function runJobWithLock(job, { key, source = 'SCHEDULE', actor = null, req = null, force = false } = {}) {
  const runKey = key ?? job.runKey();
  if (running.has(`${job.name}:${runKey}`)) {
    return { skipped: true, reason: 'ALREADY_RUNNING' };
  }
  if (!force) {
    const inserted = await query(
      `insert into job_runs (job_name, run_key, status) values ($1,$2,'STARTED')
       on conflict (job_name, run_key) do nothing returning id`,
      [job.name, runKey],
    );
    if (inserted.rowCount === 0) {
      return { skipped: true, reason: 'ALREADY_RAN_FOR_KEY', runKey };
    }
    return execute(job, runKey, source, actor, req, inserted.rows[0].id);
  }
  // Forced (manual) runs always execute; keep a separate audit trail.
  const inserted = await query(
    `insert into job_runs (job_name, run_key, status, detail) values ($1,$2,'STARTED',$3) returning id`,
    [job.name, runKey, JSON.stringify({ source, forced: true })],
  );
  return execute(job, runKey, source, actor, req, inserted.rows[0].id);
}

async function execute(job, runKey, source, actor, req, runId) {
  const lockKey = `${job.name}:${runKey}`;
  running.add(lockKey);
  const started = Date.now();
  try {
    logger.info('job started', { job: job.name, runKey, source });
    const result = await job.handler({ runKey, source, actor, req, logger });
    const durationMs = Date.now() - started;
    await query(
      `update job_runs set status = 'SUCCESS', finished_at = now(), duration_ms = $2,
              items_processed = $3, detail = $4 where id = $1`,
      [runId, durationMs, Number(result?.itemsProcessed ?? 0), JSON.stringify(result?.detail ?? result ?? {})],
    );
    logger.info('job finished', { job: job.name, runKey, durationMs, items: Number(result?.itemsProcessed ?? 0) });
    await audit.record({
      action: audit.AUDIT_ACTIONS.JOB_RUN,
      entity: 'job',
      entityId: job.name,
      newValue: { status: 'SUCCESS', runKey, durationMs, itemsProcessed: Number(result?.itemsProcessed ?? 0) },
      meta: result?.detail ?? null,
      actor,
      req,
    });
    return { ok: true, job: job.name, runKey, durationMs, result };
  } catch (err) {
    const durationMs = Date.now() - started;
    logger.error('job failed', { err, job: job.name, runKey, durationMs });
    // FAILED rows are retryable: the next tick will try again.
    await query(`update job_runs set status = 'FAILED', finished_at = now(), duration_ms = $2, error = $3 where id = $1`, [
      runId,
      durationMs,
      String(err?.message ?? err).slice(0, 500),
    ]).catch(() => {});
    await query(`delete from job_runs where id = $1 and status = 'FAILED'`, [runId]).catch(() => {});
    await audit.record({
      action: audit.AUDIT_ACTIONS.JOB_RUN,
      entity: 'job',
      entityId: job.name,
      newValue: { status: 'FAILED', runKey, durationMs, error: String(err?.message ?? err).slice(0, 300) },
      actor,
      req,
    });
    return { ok: false, job: job.name, runKey, error: String(err?.message ?? err) };
  } finally {
    running.delete(lockKey);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    lastTick.at = now.toISOString();
    lastTick.dhakaDate = dhakaDate(now);
    lastTick.minutes = dhakaMinutesOfDay(now);
    for (const job of JOBS.values()) {
      try {
        const { due, key } = isDue(job, now);
        if (!due) continue;
        const result = await runJobWithLock(job, { key });
        if (!result?.skipped) logger.debug('job tick result', { job: job.name, key });
      } catch (err) {
        // One broken job must never stop the others.
        logger.error('job tick error', { err, job: job.name });
      }
    }
  } finally {
    ticking = false;
  }
}

export async function startScheduler({ immediate = true } = {}) {
  registerDefaultJobs();
  // A crash mid-run leaves a STARTED row behind: clear those so the job retries.
  try {
    const cleared = await query(
      `delete from job_runs where status = 'STARTED' and started_at < now() - ($1 || ' minutes')::interval returning id`,
      [String(STALE_RUN_MINUTES)],
    );
    if (cleared.rowCount > 0) logger.warn('cleared stale job runs', { count: cleared.rowCount });
  } catch (err) {
    logger.error('could not clear stale job runs', { err });
  }
  timer = setInterval(() => {
    tick().catch((err) => logger.error('scheduler tick failed', { err }));
  }, TICK_MS);
  logger.info('scheduler started', {
    tickSeconds: TICK_MS / 1000,
    jobs: [...JOBS.values()].map((j) => j.name),
    timezone: 'Asia/Dhaka',
  });
  if (immediate) await tick().catch((err) => logger.error('initial tick failed', { err }));
  return { started: true, jobs: [...JOBS.keys()] };
}

// Registered at module load: the console/API "run now" path and the status
// endpoint must work even when the periodic ticker is switched off
// (JOBS_ENABLED=false, and inside the test suite).
registerDefaultJobs();

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('scheduler stopped');
  }
}

export function jobStatus() {
  return {
    enabled: config.jobs.enabled,
    running: [...running],
    lastTick,
    jobs: [...JOBS.values()].map((j) => ({
      name: j.name,
      description: j.description,
      schedule: j.schedule,
      runKey: j.runKey(),
    })),
  };
}

/** Super Admin "run now" support (bypasses the run_key lock). */
export async function runJobByName(name, { actor = null, req = null } = {}) {
  const job = JOBS.get(name);
  if (!job) return { ok: false, error: `Unknown job: ${name}`, available: [...JOBS.keys()] };
  return runJobWithLock(job, { key: `${job.runKey()}-manual-${Date.now()}`, source: 'MANUAL', actor, req, force: true });
}

export async function recentRuns(limit = 20) {
  const res = await query(
    `select job_name, run_key, status, started_at, finished_at, duration_ms, items_processed, error, detail
       from job_runs order by started_at desc limit $1`,
    [Math.min(Number(limit) || 20, 100)],
  );
  return res.rows;
}

export { JOBS };
