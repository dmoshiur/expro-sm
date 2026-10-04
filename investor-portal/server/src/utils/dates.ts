/**
 * Date helpers. All business dates (due dates, "today", reminders, cron) are
 * interpreted in Asia/Dhaka (UTC+6, no DST), regardless of the server timezone.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { badRequest } from './errors';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export const BUSINESS_TIMEZONE = 'Asia/Dhaka';
export type DhakaDayjs = dayjs.Dayjs;

/** Current instant. */
export const now = (): Date => new Date();

/** Current instant as a dayjs object in Asia/Dhaka. */
export const nowDhaka = (): DhakaDayjs => dayjs().tz(BUSINESS_TIMEZONE);

/** Start of the given Dhaka day, returned as a real Date (UTC instant). */
export function startOfDhakaDay(date: Date | string = new Date()): Date {
  return dayjs(date).tz(BUSINESS_TIMEZONE).startOf('day').toDate();
}

export function endOfDhakaDay(date: Date | string = new Date()): Date {
  return dayjs(date).tz(BUSINESS_TIMEZONE).endOf('day').toDate();
}

/**
 * Parse a "YYYY-MM-DD" date string (or Date) as midnight Asia/Dhaka and return
 * the corresponding UTC instant. This is how installment due dates are stored.
 */
export function parseDhakaDate(value: string | Date): Date {
  if (value instanceof Date) return startOfDhakaDay(value);
  const parsed = dayjs.tz(value, 'YYYY-MM-DD', BUSINESS_TIMEZONE);
  if (!parsed.isValid()) throw badRequest(`Invalid date: ${value}`);
  return parsed.startOf('day').toDate();
}

/** Format an instant as YYYY-MM-DD in Dhaka time. */
export const formatDhakaDate = (date: Date | string | null | undefined): string =>
  date ? dayjs(date).tz(BUSINESS_TIMEZONE).format('YYYY-MM-DD') : '';

/** Format an instant as "DD MMM YYYY, hh:mm A" in Dhaka time. */
export const formatDhakaDateTime = (date: Date | string | null | undefined): string =>
  date ? dayjs(date).tz(BUSINESS_TIMEZONE).format('DD MMM YYYY, hh:mm A') : '';

/**
 * Add `intervalDays` days to a due date, always landing on Dhaka midnight.
 * Used to derive installment due dates from the first due date.
 */
export function addDhakaDays(date: Date, days: number): Date {
  return dayjs(date).tz(BUSINESS_TIMEZONE).add(days, 'day').startOf('day').toDate();
}

/** Add whole months (monthly interval) keeping Dhaka midnight. */
export function addDhakaMonths(date: Date, months: number): Date {
  return dayjs(date).tz(BUSINESS_TIMEZONE).add(months, 'month').startOf('day').toDate();
}

/** Whole days from today (Dhaka) until `date`. Negative = in the past. */
export function daysUntil(date: Date): number {
  const target = dayjs(date).tz(BUSINESS_TIMEZONE).startOf('day');
  const today = nowDhaka().startOf('day');
  return target.diff(today, 'day');
}

export function isPastDue(date: Date): boolean {
  return startOfDhakaDay(date).getTime() < startOfDhakaDay().getTime();
}

/**
 * Advance a due date by one interval. `intervalUnit` is a simple enum so the UI
 * can offer daily/weekly/monthly/quarterly schedules.
 */
export function addInterval(date: Date, unit: IntervalUnit, value: number): Date {
  switch (unit) {
    case 'DAY':
      return addDhakaDays(date, value);
    case 'WEEK':
      return addDhakaDays(date, value * 7);
    case 'MONTH':
      return addDhakaMonths(date, value);
    case 'YEAR':
      return addDhakaMonths(date, value * 12);
    default:
      throw badRequest(`Unsupported interval unit: ${String(unit)}`);
  }
}

export type IntervalUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

/** Inclusive [start, end] range of a Dhaka month, e.g. 2026-03 -> [.., ..] */
export function dhakaMonthRange(month: string): { start: Date; end: Date } {
  const parsed = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', BUSINESS_TIMEZONE);
  if (!parsed.isValid()) throw badRequest('Invalid month, expected YYYY-MM');
  return { start: parsed.startOf('month').toDate(), end: parsed.endOf('month').toDate() };
}

export { dayjs };
