/** Money, date and status formatting. Amounts are poisha (integer) everywhere. */

export function formatBDT(poisha, { compact = false } = {}) {
  const value = Number(poisha ?? 0) / 100;
  if (compact && Math.abs(value) >= 10000000) return `৳${(value / 10000000).toFixed(2)} Cr`;
  if (compact && Math.abs(value) >= 100000) return `৳${(value / 100000).toFixed(2)} L`;
  return `৳${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

/** Taka input -> poisha integer (accepts "1,250.50"). */
export function takaToPoisha(input) {
  if (input === '' || input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[,\s৳]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function poishaToTakaInput(poisha) {
  if (poisha === null || poisha === undefined) return '';
  return (Number(poisha) / 100).toFixed(2);
}

export function formatDate(value) {
  if (!value) return '—';
  const iso = typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
}

export function relativeDays(isoDate) {
  if (!isoDate) return null;
  const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const a = Date.UTC(...today.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...String(isoDate).slice(0, 10).split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((b - a) / 86_400_000);
}

export function dueLabel(isoDate) {
  const days = relativeDays(isoDate);
  if (days === null) return '';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days > 0) return `in ${days} days`;
  if (days === -1) return '1 day overdue';
  return `${Math.abs(days)} days overdue`;
}

export const STATUS_LABELS = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  VERIFIED: 'Verified',
  PARTIALLY_PAID: 'Partially paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  WAIVED: 'Waived',
  CANCELLED: 'Cancelled',
  INITIATED: 'Initiated',
  SUCCESS: 'Success',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  CLOSED: 'Closed',
  SUSPENDED: 'Suspended',
};

export function statusTone(status) {
  switch (status) {
    case 'PAID':
    case 'SUCCESS':
    case 'ACTIVE':
    case 'COMPLETED':
    case 'VERIFIED':
      return 'ok';
    case 'OVERDUE':
    case 'SUSPENDED':
    case 'FAILED':
    case 'CLOSED':
    case 'REJECTED':
      return 'danger';
    case 'PARTIALLY_PAID':
    case 'PENDING':
    case 'INITIATED':
      return 'warn';
    case 'WAIVED':
    case 'CANCELLED':
    case 'INACTIVE':
    case 'REFUNDED':
      return 'muted';
    default:
      return 'info';
  }
}

/**
 * Bangladeshi mobile normalisation for form payloads: accepts 01712345678,
 * +8801712345678, 880 1712-345678 and returns 01XXXXXXXXX. The API validator
 * normalises too, but doing it in the form avoids avoidable 422 responses.
 */
export function normalizeBdPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  // The country code replaces the leading 0: +880 1712-345678 -> 01712345678.
  if (digits.startsWith('00880')) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith('880')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('88')) digits = `0${digits.slice(2)}`;
  return digits;
}

export function isValidBdPhone(value) {
  return /^01[3-9]\d{8}$/.test(normalizeBdPhone(value));
}

/** NID input -> digits only (10, 13 or 17 digits accepted by the API). */
export function normalizeNid(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 17);
}

export function isValidNid(value) {
  return /^\d{10}$|^\d{13}$|^\d{17}$/.test(normalizeNid(value));
}

/**
 * Human grouping for the three NID lengths the API accepts. The stored value is
 * always digits only; this is display sugar so staff can eyeball the number.
 */
export function formatNid(value) {
  const digits = normalizeNid(value);
  if (digits.length === 13) return `${digits.slice(0, 4)} ${digits.slice(4, 10)} ${digits.slice(10)}`;
  if (digits.length === 17) return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 15)} ${digits.slice(15)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return digits;
}

/** 0-3 quality hint used next to the NID input. */
export function nidHint(value) {
  const digits = normalizeNid(value);
  if (!digits) return { tone: 'muted', text: '10, 13 or 17 digits' };
  if (digits.length === 10 || digits.length === 13 || digits.length === 17) return { tone: 'ok', text: `${digits.length} digits · accepted` };
  return { tone: 'warn', text: `${digits.length} digits · needs 10, 13 or 17` };
}

export function maskMobile(mobile) {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (digits.length < 6) return '—';
  return `${digits.slice(0, 4)}*****${digits.slice(-2)}`;
}

export function csvFilename(base) {
  return `${base}-${new Date().toISOString().slice(0, 10)}.csv`;
}
