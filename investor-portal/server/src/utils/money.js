/**
 * Money is ALWAYS an integer number of poisha (1 BDT = 100 poisha) in the
 * database, in the API and in the services. Formatting happens in the UI only.
 * BIGINT columns are parsed to JS numbers by db/pool.js; poisha amounts stay far
 * below Number.MAX_SAFE_INTEGER (9e15 poisha = 9e13 BDT = 90 lakh crore BDT).
 */

export function toPoisha(taka) {
  const n = typeof taka === 'string' ? Number(taka.replace(/[,\s৳]/g, '')) : Number(taka);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 100);
}

export function toTaka(poisha) {
  return Number(poisha) / 100;
}

export function formatBDT(poisha, { withSymbol = true, decimals = 2 } = {}) {
  const n = toTaka(poisha ?? 0);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return withSymbol ? `BDT ${formatted}` : formatted;
}

export function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Split a total into `count` installments in poisha with an EVEN base and the
 * integer remainder added to the LAST installment. Guarantees:
 *   - every installment > 0 (throws when the total cannot cover the count)
 *   - sum(split) === total  (exact, no float drift)
 */
export function splitAmount(totalPoisha, count) {
  if (!isPositiveInt(totalPoisha)) throw new Error('Total amount must be a positive integer (poisha)');
  if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error('Installment count must be between 1 and 120');
  if (totalPoisha < count) throw new Error('Total amount is too small to split into that many installments');
  const base = Math.floor(totalPoisha / count);
  const remainder = totalPoisha - base * count;
  const amounts = new Array(count).fill(base);
  amounts[count - 1] = base + remainder;
  return amounts;
}

/**
 * Due dates for a schedule. `interval` is 'MONTHLY' or 'WEEKLY' (defaults to
 * monthly). Month-end clamping is applied (31 Jan + 1 month = 28/29 Feb).
 */
export function buildDueDates(firstDueDate, count, interval = 'MONTHLY') {
  const dates = [];
  const [y, m, d] = String(firstDueDate).split('-').map(Number);
  for (let i = 0; i < count; i += 1) {
    if (interval === 'WEEKLY') {
      const base = new Date(Date.UTC(y, m - 1, d));
      base.setUTCDate(base.getUTCDate() + i * 7);
      dates.push(base.toISOString().slice(0, 10));
    } else {
      const year = y + Math.floor((m - 1 + i) / 12);
      const month = ((m - 1 + i) % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      dates.push(`${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`);
    }
  }
  return dates;
}

/** The plan the services write to the DB: amounts + due dates + serials. */
export function buildInstallmentPlan({ totalAmount, installmentCount, firstDueDate, interval = 'MONTHLY' }) {
  const amounts = splitAmount(totalAmount, installmentCount);
  const dates = buildDueDates(firstDueDate, installmentCount, interval);
  return amounts.map((amount, i) => ({ serial: i + 1, amount, dueDate: dates[i] }));
}
