/**
 * Date helpers fixed to Asia/Dhaka (UTC+6, no DST anywhere in Bangladesh
 * history since 2009 and none planned). All "today"/"now" business logic goes
 * through these helpers so jobs and reports agree with the wall clock an
 * accountant in Dhaka sees.
 */
export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
export const TIMEZONE = 'Asia/Dhaka';

/** Dhaka-local YYYY-MM-DD for a given instant (default: now). */
export function dhakaDate(instant = new Date()) {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Dhaka-local YYYY-MM-DD HH:MM:SS. */
export function dhakaDateTimeString(instant = new Date()) {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** Dhaka-local {y,m,d,hh,mm,ss} parts. */
export function dhakaParts(instant = new Date()) {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  const iso = new Date(t + DHAKA_OFFSET_MS).toISOString();
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
    hour: Number(iso.slice(11, 13)),
    minute: Number(iso.slice(14, 16)),
    second: Number(iso.slice(17, 19)),
    date: iso.slice(0, 10),
  };
}

export function dhakaMinutesOfDay(instant = new Date()) {
  const p = dhakaParts(instant);
  return p.hour * 60 + p.minute;
}

/**
 * Coerce anything date-ish (string, Date object, ISO timestamp) into a plain
 * 'YYYY-MM-DD' string. Defensive: the database client already returns date columns as strings.
 */
export function isoDateOnly(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return new Date(value.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
  }
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

export function parseHHMM(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) throw new Error(`Invalid HH:MM time: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** ISO date (YYYY-MM-DD) validation + normalisation (accepts Date too). */
export function isValidIsoDate(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= lastDay;
}

export function addDays(isoDate, days) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function addMonths(isoDate, months) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  // Floor division and a non-negative remainder so negative offsets roll back correctly (JS % keeps the sign).
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

export function diffDays(fromIso, toIso) {
  const a = Date.UTC(...String(fromIso).split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...String(toIso).split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((b - a) / 86_400_000);
}

export function isWeekendDhaka(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 5 || dow === 6; // Friday & Saturday weekend in Bangladesh
}

export function toIsoTimestamp(instant = new Date()) {
  return (instant instanceof Date ? instant : new Date(instant)).toISOString();
}

/** First day of the Dhaka month for an instant (YYYY-MM-01). */
export function dhakaMonthStart(instant = new Date()) {
  return `${dhakaDate(instant).slice(0, 7)}-01`;
}

/** Inclusive list of YYYY-MM month keys between two dates. */
export function monthKeysBetween(fromIso, toIso) {
  const keys = [];
  let cursor = `${String(fromIso).slice(0, 7)}-01`;
  const end = String(toIso).slice(0, 7);
  let guard = 0;
  while (cursor.slice(0, 7) <= end && guard < 240) {
    keys.push(cursor.slice(0, 7));
    cursor = addMonths(cursor, 1);
    guard += 1;
  }
  return keys;
}
