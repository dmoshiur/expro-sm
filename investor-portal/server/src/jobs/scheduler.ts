/**
 * Cron scheduler abstraction.
 *
 * Jobs are registered with a name, a cron expression and an Asia/Dhaka
 * timezone. The implementation is deliberately tiny and isolated behind this
 * interface so it can be swapped for pg-boss (or any queue) later without
 * touching a single job definition:
 *
 *   export const scheduler: Scheduler = createPgBossScheduler(...)
 */
import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config';
import { jobLogger } from '../utils/logger';
import { prisma } from '../config/prisma';

export interface JobDefinition {
  name: string;
  /** cron expression, evaluated in config.cron.timezone (Asia/Dhaka) */
  schedule: string;
  /** skip the run when the app runs in test mode */
  skipInTest?: boolean;
  handler: (context: JobContext) => Promise<JobResult | void>;
  timezone?: string;
}

export interface JobContext {
  /** ISO timestamp of the run, in Asia/Dhaka */
  startedAt: Date;
  logger: ReturnType<typeof jobLogger>;
}

export interface JobResult {
  /** short human readable summary, stored in the job run log */
  summary: string;
  /** counters shown on the dashboard / in logs */
  metrics?: Record<string, number>;
}

export interface Scheduler {
  register(job: JobDefinition): void;
  start(): void;
  stop(): void;
  /** runs a job immediately (used by the admin "Run now" button and tests) */
  runNow(name: string): Promise<JobResult | void>;
  list(): Array<{ name: string; schedule: string; timezone: string; running: boolean }>;
}

export function createCronScheduler(): Scheduler {
  const jobs = new Map<string, { definition: JobDefinition; task?: ScheduledTask; running: boolean }>();

  const execute = async (job: JobDefinition): Promise<JobResult | void> => {
    const logger = jobLogger(job.name);
    const startedAt = new Date();
    const startedMs = Date.now();
    const entry = jobs.get(job.name);
    if (entry) entry.running = true;
    try {
      const result = await job.handler({ startedAt, logger });
      logger.info(
        { ms: Date.now() - startedMs, summary: result?.summary, ...(result?.metrics ?? {}) },
        `job finished: ${job.name}`,
      );
      return result;
    } catch (error) {
      // Never let one failing job kill the process or the scheduler.
      logger.error({ err: error, ms: Date.now() - startedMs }, `job failed: ${job.name}`);
      await recordJobRun(job.name, startedAt, 'FAILED', (error as Error).message);
      return undefined;
    } finally {
      if (entry) entry.running = false;
    }
  };

  return {
    register(job) {
      if (jobs.has(job.name)) throw new Error(`Job "${job.name}" is already registered`);
      jobs.set(job.name, { definition: job, running: false });
      jobLogger(job.name).debug({ schedule: job.schedule }, 'job registered');
    },

    start() {
      for (const [name, entry] of jobs) {
        const { definition } = entry;
        if (config.isTest && definition.skipInTest !== false) continue;
        if (!cron.validate(definition.schedule)) {
          jobLogger(name).error({ schedule: definition.schedule }, 'invalid cron expression - job not scheduled');
          continue;
        }
        entry.task = cron.schedule(definition.schedule, () => void execute(definition), {
          timezone: definition.timezone ?? config.cron.timezone,
        });
        jobLogger(name).info(
          { schedule: definition.schedule, timezone: definition.timezone ?? config.cron.timezone },
          'job scheduled',
        );
      }
    },

    stop() {
      for (const entry of jobs.values()) {
        entry.task?.stop();
        entry.task = undefined;
      }
    },

    async runNow(name) {
      const entry = jobs.get(name);
      if (!entry) throw new Error(`Unknown job: ${name}`);
      return execute(entry.definition);
    },

    list: () =>
      [...jobs.values()].map((entry) => ({
        name: entry.definition.name,
        schedule: entry.definition.schedule,
        timezone: entry.definition.timezone ?? config.cron.timezone,
        running: entry.running,
      })),
  };
}

/**
 * Job runs are written to audit_logs so operators can see the automation trail
 * next to human actions. Failures are recorded too - the audit table is
 * append-only, so this is a reliable history.
 */
async function recordJobRun(
  jobName: string,
  startedAt: Date,
  outcome: 'SUCCESS' | 'FAILED',
  detail?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: `system.job.${outcome.toLowerCase()}`,
        entity: 'Job',
        entityId: jobName,
        newValue: { job: jobName, startedAt: startedAt.toISOString(), outcome, detail: detail?.slice(0, 500) ?? null },
      },
    });
  } catch {
    // logging must never break a job
  }
}
