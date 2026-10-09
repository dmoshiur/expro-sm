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
};

export function statusTone(status) {
  switch (status) {
    case 'PAID':
    case 'SUCCESS':
    case 'ACTIVE':
      return 'ok';
    case 'OVERDUE':
    case 'FAILED':
    case 'CLOSED':
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

export function maskMobile(mobile) {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (digits.length < 6) return '—';
  return `${digits.slice(0, 4)}*****${digits.slice(-2)}`;
}

export function csvFilename(base) {
  return `${base}-${new Date().toISOString().slice(0, 10)}.csv`;
}
