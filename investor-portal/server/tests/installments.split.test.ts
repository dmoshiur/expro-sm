import { describe, expect, it } from 'vitest';
import { bdtToPoisha, formatBdt, formatPoisha, poishaToBdt, splitIntoInstallments, sumPoisha } from '../src/utils/money';
import { planDueDates, planInstallments } from '../src/services/installment/installment.service';
import { addDhakaDays, daysUntil, formatDhakaDate, parseDhakaDate, startOfDhakaDay } from '../src/utils/dates';

describe('money: integer poisha only', () => {
  it('converts BDT strings and numbers to poisha without float drift', () => {
    expect(bdtToPoisha('100')).toBe(10000n);
    expect(bdtToPoisha('1234.56')).toBe(123456n);
    expect(bdtToPoisha(1234.56)).toBe(123456n);
    expect(bdtToPoisha('0.01')).toBe(1n);
    expect(bdtToPoisha('1,25,000.50')).toBe(12500050n);
    expect(bdtToPoisha(0.1 + 0.2)).toBe(30n); // 0.30000000000000004 -> "0.30"
  });

  it('rejects malformed amounts', () => {
    expect(() => bdtToPoisha('abc')).toThrow(/Invalid amount/);
    expect(() => bdtToPoisha('10.999')).toThrow(/Invalid amount/);
    expect(() => bdtToPoisha(-5)).toThrow(/Invalid amount/);
  });

  it('formats poisha as BDT', () => {
    expect(formatPoisha(123456n)).toBe('1,234.56');
    expect(formatBdt(100n)).toBe('৳ 1.00');
    expect(formatPoisha(0n)).toBe('0.00');
    expect(poishaToBdt(123456n)).toBe(1234.56);
  });
});

describe('installment split', () => {
  it('splits evenly when the total divides exactly', () => {
    expect(splitIntoInstallments(bdtToPoisha('9000'), 3)).toEqual([300000n, 300000n, 300000n]);
  });

  it('puts the rounding remainder in the LAST installment', () => {
    const parts = splitIntoInstallments(bdtToPoisha('10000'), 3);
    expect(parts).toEqual([333333n, 333333n, 333334n]);
    expect(sumPoisha(parts)).toBe(bdtToPoisha('10000'));
  });

  it('keeps the sum exact for awkward totals', () => {
    for (const [total, count] of [
      ['0.05', 3],
      ['999.99', 7],
      ['125000.50', 12],
      ['1', 3],
      ['7777777.77', 120],
    ] as const) {
      const parts = splitIntoInstallments(bdtToPoisha(total), count);
      expect(parts).toHaveLength(count);
      expect(sumPoisha(parts)).toBe(bdtToPoisha(total));
      // all installments except the last are identical, and the last one
      // carries the whole remainder (which is always smaller than the count)
      const head = parts.slice(0, -1);
      expect(new Set(head.map(String)).size).toBe(1);
      expect(parts.at(-1)! - head[0]!).toBeGreaterThanOrEqual(0n);
      expect(parts.at(-1)! - head[0]!).toBeLessThan(BigInt(count));
      expect(parts.at(-1)! - head[0]! < 1n || parts.at(-1)! - head[0]! >= 0n).toBe(true);
    }
  });

  it('refuses impossible splits', () => {
    expect(() => splitIntoInstallments(bdtToPoisha('1'), 0)).toThrow();
    expect(() => splitIntoInstallments(bdtToPoisha('0.01'), 3)).toThrow(/too small/i);
    expect(() => splitIntoInstallments(0n, 3)).toThrow();
  });

  it('planInstallments accepts the raw UI value', () => {
    expect(planInstallments('10,000.00', 3).map(String)).toEqual(['333333', '333333', '333334']);
  });
});

describe('installment scheduling', () => {
  it('derives due dates from the first due date and the interval', () => {
    const dates = planDueDates('2026-01-15', { unit: 'MONTH', value: 1 }, 3);
    expect(dates.map(formatDhakaDate)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);

    const weekly = planDueDates('2026-01-15', { unit: 'WEEK', value: 2 }, 3);
    expect(weekly.map(formatDhakaDate)).toEqual(['2026-01-15', '2026-01-29', '2026-02-12']);
  });

  it('parses Dhaka dates as midnight in Asia/Dhaka (UTC+6)', () => {
    const parsed = parseDhakaDate('2026-01-15');
    expect(parsed.toISOString()).toBe('2026-01-14T18:00:00.000Z');
    expect(formatDhakaDate(parsed)).toBe('2026-01-15');
  });

  it('counts days until a due date in Dhaka terms', () => {
    const today = startOfDhakaDay();
    expect(daysUntil(today)).toBe(0);
    expect(daysUntil(addDhakaDays(today, 5))).toBe(5);
    expect(daysUntil(addDhakaDays(today, -3))).toBe(-3);
  });
});
