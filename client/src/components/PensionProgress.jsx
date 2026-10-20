/**
 * Pension progress: how many installments are paid, how much is still left,
 * and a maturity forecast from the last scheduled due date. All figures come
 * from the dashboard summary (ledger data, never client-side guesses).
 */
import { formatBDT, formatDate } from '../utils/format.js';

/** Whole months from today (Asia/Dhaka calendar) to a YYYY-MM-DD date. */
export function monthsUntil(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const [year, month, day] = String(isoDate).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  const dhaka = new Date(now.getTime() + 6 * 3600_000);
  const todayMonths = dhaka.getUTCFullYear() * 12 + dhaka.getUTCMonth();
  const targetMonths = year * 12 + (month - 1);
  const months = targetMonths - todayMonths - (dhaka.getUTCDate() < day ? 1 : 0);
  return Math.max(0, months);
}

export function PensionProgress({ summary, overdue = false }) {
  const total = summary?.total_installments ?? 0;
  const paid = summary?.paid_installments ?? 0;
  const pct = total ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  const remainingCount = Math.max(0, total - paid);
  const monthsLeft = monthsUntil(summary?.maturity_date);

  return (
    <section className="pension" aria-label="Pension progress">
      <div className="pension-head">
        <div>
          <div className="small muted" style={{ fontWeight: 600 }}>Pension progress</div>
          <div className="pension-count">
            {paid}
            <small>of {total} installments paid</small>
          </div>
        </div>
        <div className="spacer" />
        <span className="pension-pct">{pct}% completed</span>
      </div>

      <div className={`meter ${overdue ? 'warn' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="pension-foot">
        <span>{total ? `${remainingCount} installment${remainingCount === 1 ? '' : 's'} to go` : 'No plan yet'}</span>
        <span>{overdue ? 'Overdue installments need attention' : 'On schedule'}</span>
      </div>

      <div className="pension-grid">
        <div className="pension-cell">
          <div className="label">Total invested</div>
          <div className="value">{formatBDT(summary?.total_invested ?? 0)}</div>
        </div>
        <div className="pension-cell">
          <div className="label">Total paid</div>
          <div className="value">{formatBDT(summary?.total_paid ?? 0)}</div>
        </div>
        <div className="pension-cell">
          <div className="label">Remaining</div>
          <div className="value">{formatBDT(summary?.total_remaining ?? 0)}</div>
        </div>
        <div className="pension-cell">
          <div className="label">Plans</div>
          <div className="value">
            {summary?.active_investments ?? 0} active · {summary?.completed_investments ?? 0} done
          </div>
        </div>
      </div>

      <div className="forecast">
        <span aria-hidden="true">◷</span>
        <div>
          {summary?.maturity_date ? (
            <>
              Expected maturity <strong>{formatDate(summary.maturity_date)}</strong>
              {monthsLeft !== null ? (
                <>
                  {' '}
                  · {monthsLeft === 0 ? 'this month' : `about ${monthsLeft} month${monthsLeft === 1 ? '' : 's'} away`}
                </>
              ) : null}
              . The forecast follows the last scheduled installment.
            </>
          ) : (
            'Maturity date appears once an installment plan is scheduled.'
          )}
        </div>
      </div>
    </section>
  );
}
