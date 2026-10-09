/**
 * Reconciliation (every RECONCILE_STUCK_AFTER_MINUTES, default 15 min):
 * re-queries the gateway for payments stuck in INITIATED/PENDING so a lost
 * callback still results in the installment being marked PAID, and abandoned
 * attempts are moved to CANCELLED instead of lingering forever.
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { findStuckPayments, refreshPaymentStatus, expireAbandonedPayments } from '../services/payment.service.js';
import { getGateway } from '../services/gateways/index.js';

export async function runReconcileJob({ limit = 25, applyAbandonment = true } = {}) {
  const gateway = getGateway();
  const stuck = await findStuckPayments({ olderThanMinutes: config.payments.reconcileStuckAfterMinutes, limit });
  const summary = { checked: stuck.length, settled: 0, failed: 0, cancelled: 0, stillPending: 0, errors: 0, abandonedCancelled: 0 };

  for (const payment of stuck) {
    try {
      const result = await refreshPaymentStatus(payment.id, { source: 'RECONCILE' });
      if (result?.state === 'success' && !result.unchanged) summary.settled += 1;
      else if (result?.state === 'failed') summary.failed += 1;
      else if (result?.state === 'cancelled') summary.cancelled += 1;
      else summary.stillPending += 1;
    } catch (err) {
      summary.errors += 1;
      logger.error('reconciliation failed for payment', { err, paymentId: payment.id });
    }
  }

  if (applyAbandonment) {
    const abandoned = await expireAbandonedPayments({ olderThanHours: 24 });
    summary.abandonedCancelled = abandoned.length;
  }

  return {
    itemsProcessed: summary.checked + summary.abandonedCancelled,
    detail: { gateway: gateway.name, thresholdMinutes: config.payments.reconcileStuckAfterMinutes, ...summary },
  };
}
