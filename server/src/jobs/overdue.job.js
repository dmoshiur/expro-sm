/**
 * Daily sweep (default 00:10 Asia/Dhaka): installments whose due date has
 * passed become OVERDUE. Idempotent - the UPDATE only touches rows that are
 * still PENDING/PARTIALLY_PAID.
 */
import { markOverdue } from '../services/installment.service.js';
import { dhakaDate } from '../utils/dates.js';

export async function runOverdueJob() {
  const asOf = dhakaDate();
  const rows = await markOverdue({ asOf });
  return {
    itemsProcessed: rows.length,
    detail: {
      asOf,
      markedOverdue: rows.length,
      installmentIds: rows.map((r) => r.id).slice(0, 500),
    },
  };
}
