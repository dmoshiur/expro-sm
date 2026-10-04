/** Money + date helpers. Every amount arrives from the API as integer poisha. */
export const POISHA = 100;

export function bdt(poisha: string | number | bigint | null | undefined, options: { decimals?: boolean } = {}): string {
  if (poisha === null || poisha === undefined || poisha === '') return '৳ 0';
  const value = Number(poisha) / POISHA;
  return `৳ ${value.toLocaleString('en-BD', {
    minimumFractionDigits: options.decimals ? 2 : 0,
    maximumFractionDigits: options.decimals ? 2 : 2,
  })}`;
}

/** poisha -> plain taka string for <input type="number"> style fields */
export function poishaToTakaInput(poisha: string | number | null | undefined): string {
  if (poisha === null || poisha === undefined || poisha === '') return '';
  return String(Number(poisha) / POISHA);
}

export function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Dhaka',
  });
}

export function todayDhaka(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function titleCase(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
