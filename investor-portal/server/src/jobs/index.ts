/**
 * Job registry.
 *
 * Every scheduled job is declared here so its cron expression, timezone and
 * behaviour are visible in one place. All schedules are evaluated in
 * Asia/Dhaka (see CRON_TIMEZONE).
 */
import { config } from '../config';
import { createCronScheduler, type Scheduler } from './scheduler';
import { overdueInstallmentsJob } from './overdueInstallments.job';
import { tokenCleanupJob } from './tokenCleanup.job';

export const scheduler: Scheduler = createCronScheduler();

let registered = false;

export function registerJobs(): void {
  if (registered) return;
  registered = true;

  // 00:05 Dhaka - flag installments whose due date has passed
  scheduler.register({
    name: 'overdue-installments',
    schedule: config.cron.overdueMark,
    timezone: config.cron.timezone,
    handler: overdueInstallmentsJob,
  });

  // 02:30 Dhaka - expire stale payment links, prune old SMS logs
  scheduler.register({
    name: 'token-cleanup',
    schedule: config.cron.tokenCleanup,
    timezone: config.cron.timezone,
    handler: tokenCleanupJob,
  });
}

/** Registered by later phases once their services exist. */
export function registerJob(job: Parameters<Scheduler['register']>[0]): void {
  scheduler.register(job);
}

export function startJobs(): void {
  registerJobs();
  scheduler.start();
}

export function stopJobs(): void {
  scheduler.stop();
}

export { createCronScheduler };
export type { Scheduler };
