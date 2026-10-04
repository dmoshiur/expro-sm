/**
 * Reconciliation - runs every 15 minutes (config.cron.reconcile).
 *
 * Investors close browser tabs, bKash callbacks get lost, and webhooks may not
 * be configured at all. Without this job a successful payment could sit in
 * PENDING forever while the installment stays unpaid.
 *
 * Strategy (see paymentService.reconcileStalePayments):
 *  - only payments in INITIATED/PENDING older than 10 minutes are considered;
 *  - each one is re-queried at the gateway;
 *  - a fully verified transaction is settled exactly like a live callback
 *    (same DB transaction, same audit trail, idempotent by gateway id);
 *  - terminal gateway failures are marked FAILED so nobody waits on them.
 *
 * If the gateway is unreachable the job logs and exits without changing data -
 * it will try again on the next tick.
 */
import { paymentService } from '../services/payment/payment.service';
import { jobLogger } from '../utils/logger';
import type { JobContext, JobResult } from './scheduler';

export async function reconcilePaymentsJob(context: JobContext): Promise<JobResult> {
  const log = context.logger ?? jobLogger('reconcile-payments');

  const result = await paymentService.reconcileStalePayments({ olderThanMinutes: 10 });

  if (result.checked === 0) {
    return { summary: 'no stale gateway payments', metrics: { checked: 0, settled: 0, failed: 0 } };
  }

  log.info(result, 'reconciliation finished');
  return {
    summary: `checked ${result.checked}, settled ${result.settled}, failed ${result.failed}, still pending ${result.stillPending}, errors ${result.errors}`,
    metrics: { checked: result.checked, settled: result.settled, failed: result.failed, pending: result.stillPending, errors: result.errors },
  };
}

export default reconcilePaymentsJob;
