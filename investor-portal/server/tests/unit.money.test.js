/** Installment split / remainder / date schedule maths (pure functions). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount, buildDueDates, buildInstallmentPlan, formatBDT, toPoisha, toTaka } from '../src/utils/money.js';

test('splitAmount: even split produces identical installments', () => {
  assert.deepEqual(splitAmount(1_200_000, 12), new Array(12).fill(100_000));
});

test('splitAmount: remainder goes to the LAST installment', () => {
  const parts = splitAmount(10_000_01, 3); // 10000.01 BDT = 1000001 poisha
  assert.deepEqual(parts, [333_333, 333_333, 333_335]);
  assert.equal(parts.reduce((sum, value) => sum + value, 0), 10_000_01);
});

test('splitAmount: sum is exact for many awkward totals', () => {
  for (const total of [1, 2, 7, 999, 1_000_001, 123_456_789, 99_999_999_999]) {
    for (const count of [1, 2, 3, 7, 11, 12, 60, 120]) {
      if (total < count) continue;
      const parts = splitAmount(total, count);
      assert.equal(parts.length, count);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `total=${total} count=${count}`);
      assert.ok(parts.every((part) => part > 0));
      // only the last installment may differ
      for (let i = 0; i < count - 1; i += 1) assert.equal(parts[i], parts[0]);
    }
  }
});

test('splitAmount rejects impossible inputs', () => {
  assert.throws(() => splitAmount(0, 3), /positive integer/);
  assert.throws(() => splitAmount(100, 0), /between 1 and 120/);
  assert.throws(() => splitAmount(2, 5), /too small/);
  assert.throws(() => splitAmount(1000, 121), /between 1 and 120/);
});

test('buildDueDates clamps month ends (31 Jan + 1 month = 28/29 Feb)', () => {
  assert.deepEqual(buildDueDates('2026-01-31', 4, 'MONTHLY'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  // 2028 is a leap year
  assert.deepEqual(buildDueDates('2028-01-31', 2, 'MONTHLY'), ['2028-01-31', '2028-02-29']);
  assert.deepEqual(buildDueDates('2026-11-30', 3, 'MONTHLY'), ['2026-11-30', '2026-12-30', '2027-01-30']);
});

test('buildDueDates weekly interval', () => {
  assert.deepEqual(buildDueDates('2026-03-01', 3, 'WEEKLY'), ['2026-03-01', '2026-03-08', '2026-03-15']);
});

test('buildInstallmentPlan keeps serials, amounts and dates aligned', () => {
  const plan = buildInstallmentPlan({ totalAmount: 10_000_01, installmentCount: 3, firstDueDate: '2026-01-31', interval: 'MONTHLY' });
  assert.deepEqual(
    plan.map((p) => p.serial),
    [1, 2, 3],
  );
  assert.equal(plan[2].amount, 333_335);
  assert.equal(plan[0].dueDate, '2026-01-31');
  assert.equal(plan.reduce((sum, p) => sum + p.amount, 0), 10_000_01);
});

test('money conversion helpers round-trip', () => {
  assert.equal(toPoisha('1,250.50'), 125_050);
  assert.equal(toPoisha(1000), 100_000);
  assert.equal(toTaka(125_050), 1250.5);
  assert.equal(formatBDT(125_050), 'BDT 1,250.50');
  assert.equal(formatBDT(0), 'BDT 0.00');
});
