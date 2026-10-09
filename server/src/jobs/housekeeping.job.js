/**
 * Daily housekeeping (03:15 Asia/Dhaka):
 *   * revoke expired sessions and delete long-expired ones
 *   * keep the sessions table small (single Turso database by design)
 *   * refresh INVESTMENT status (ACTIVE -> COMPLETED) after manual data edits
 */
import { query } from '../db/client.js';
import { NOW } from '../db/sql.js';

export async function runHousekeepingJob() {
  const expired = await query(
    `update sessions set revoked_at = ${NOW}, revoked_reason = 'EXPIRED'
      where revoked_at is null and expires_at < ${NOW} returning id`,
  );
  const purgeBefore = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const purged = await query('delete from sessions where expires_at < ?1 returning id', [purgeBefore]);

  // Safety net for the investment status invariant (cheap, idempotent).
  const stale = await query(
    `select v.id from investments v
      where v.status = 'ACTIVE'
        and not exists (select 1 from installments inst
                         where inst.investment_id = v.id and inst.status in ('PENDING','PARTIALLY_PAID','OVERDUE'))
      limit 200`,
  );
  let statusFixed = 0;
  for (const row of stale.rows) {
    const changed = await query('select status from investments where id = ?1', [row.id]);
    if (changed.rows[0]?.status === 'ACTIVE') {
      await query(`update investments set status = ?2, updated_at = ${NOW} where id = ?1`, [row.id, 'COMPLETED']);
      statusFixed += 1;
    }
  }

  return {
    itemsProcessed: expired.rowCount + purged.rowCount + statusFixed,
    detail: { sessionsExpired: expired.rowCount, sessionsPurged: purged.rowCount, investmentsCompleted: statusFixed },
  };
}
