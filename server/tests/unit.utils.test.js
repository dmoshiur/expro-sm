/** Dates (Asia/Dhaka), validators, masking, CSV, rate limiting, security headers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareEnv } from './helpers/harness.js';

prepareEnv();

const dates = await import('../src/utils/dates.js');
const validate = await import('../src/utils/validate.js');
const mask = await import('../src/utils/mask.js');
const csv = await import('../src/utils/csv.js');
const pagination = await import('../src/utils/pagination.js');

test('Dhaka date helpers use UTC+6 with no DST', () => {
  // 2026-03-31T18:30Z is already 2026-04-01 00:30 in Dhaka
  assert.equal(dates.dhakaDate(new Date('2026-03-31T18:30:00Z')), '2026-04-01');
  assert.equal(dates.dhakaDate(new Date('2026-03-31T17:59:59Z')), '2026-03-31');
  assert.equal(dates.dhakaDateTimeString(new Date('2026-03-31T18:30:00Z')), '2026-04-01 00:30:00');
  const parts = dates.dhakaParts(new Date('2026-12-31T20:00:00Z'));
  assert.deepEqual({ y: parts.year, m: parts.month, d: parts.day, h: parts.hour }, { y: 2027, m: 1, d: 1, h: 2 });
  assert.equal(dates.dhakaMinutesOfDay(new Date('2026-01-01T03:00:00Z')), 9 * 60);
});

test('ISO date helpers: validation, arithmetic and clamping', () => {
  assert.equal(dates.isValidIsoDate('2026-02-28'), true);
  assert.equal(dates.isValidIsoDate('2026-02-30'), false);
  assert.equal(dates.isValidIsoDate('2026-13-01'), false);
  assert.equal(dates.isValidIsoDate('28/02/2026'), false);
  assert.equal(dates.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(dates.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(dates.addMonths('2026-01-31', 3), '2026-04-30');
  assert.equal(dates.diffDays('2026-01-01', '2026-01-31'), 30);
  assert.equal(dates.diffDays('2026-01-31', '2026-01-01'), -30);
  assert.equal(dates.isoDateOnly(new Date('2026-04-01T00:30:00+06:00')), '2026-04-01');
  assert.equal(dates.isoDateOnly('2026-04-01T00:30:00.000Z'), '2026-04-01');
  // Friday & Saturday are the Bangladeshi weekend
  assert.equal(dates.isWeekendDhaka('2026-01-02'), true); // Friday
  assert.equal(dates.isWeekendDhaka('2026-01-03'), true); // Saturday
  assert.equal(dates.isWeekendDhaka('2026-01-04'), false); // Sunday
});

test('monthKeysBetween spans years correctly', () => {
  assert.deepEqual(dates.monthKeysBetween('2025-11-01', '2026-02-15'), ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('mobile / NID / email validators', () => {
  assert.equal(validate.isValidBdMobile('01712345678'), true);
  assert.equal(validate.isValidBdMobile('+8801712345678'), true);
  assert.equal(validate.isValidBdMobile('0171234567'), false);
  assert.equal(validate.isValidBdMobile('02712345678'), false);
  assert.equal(validate.normalizeBdMobile('+88 017 1234 5678'), '01712345678');
  assert.equal(validate.normalizeBdMobile('12345'), null);

  assert.equal(validate.isValidNid('1990123456789'), true); // 13
  assert.equal(validate.isValidNid('1234567890'), true); // 10
  assert.equal(validate.isValidNid('12345678901234567'), true); // 17
  assert.equal(validate.isValidNid('12345'), false);
  assert.equal(validate.cleanNid('1990-1234-56789'), '1990123456789');

  assert.equal(validate.isValidEmail('a@b.co'), true);
  assert.equal(validate.isValidEmail('bad@@b.co'), false);
});

test('Validator collects field errors and returns sanitised values', () => {
  const v = new validate.Validator({ name: '  Rahim Uddin  ', mobile: '+8801712345678', age: '42', nid: '1990-123456789' });
  v.string('name', { required: true, max: 120, label: 'Name' });
  v.mobile('mobile', { required: true });
  v.int('age', { required: true, min: 18, max: 120 });
  v.nid('nid', { required: true });
  const values = v.result();
  assert.deepEqual(values, { name: 'Rahim Uddin', mobile: '01712345678', age: 42, nid: '1990123456789' });

  const bad = new validate.Validator({ name: '', mobile: '123', age: 'x' });
  bad.string('name', { required: true, label: 'Name' });
  bad.mobile('mobile', { required: true });
  bad.int('age', { required: true });
  assert.throws(() => bad.result(), (err) => {
    assert.equal(err.status, 422);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.match(err.details.name, /required/);
    assert.match(err.details.mobile, /valid Bangladeshi/);
    assert.match(err.details.age, /number/);
    return true;
  });
});

test('Validator.array validates nested items with indexed error paths', () => {
  const v = new validate.Validator({
    nominees: [
      { name: 'A', relation: 'Spouse', mobile: '01712345678', share_percent: 60 },
      { name: '', relation: 'Son', mobile: 'nope', share_percent: '40' },
    ],
  });
  const items = v.array(
    'nominees',
    (item, index, sub) => {
      sub.string('name', { required: true, label: 'Nominee name' });
      sub.string('relation', { required: true, label: 'Relation' });
      sub.mobile('mobile', { required: true });
      return { name: sub.values.name, relation: sub.values.relation, mobile: sub.values.mobile };
    },
    { max: 3 },
  );
  assert.throws(() => v.result(), (err) => {
    assert.ok(err.details['nominees[1].name']);
    assert.ok(err.details['nominees[1].mobile']);
    return true;
  });
  assert.equal(items.length, 1);
});

test('masking never leaks full mobiles, emails or NIDs', () => {
  assert.equal(mask.maskMobile('01712345678'), '0171*****78');
  assert.equal(mask.maskMobile('+8801712345678'), '0171*****78');
  assert.equal(mask.maskMobile('123'), '***');
  assert.equal(mask.maskEmail('rahim@example.com'), 'ra***@example.com');
  assert.equal(mask.maskNid('1990123456789'), '*********6789');
  assert.equal(mask.firstNameOnly('Rahim Uddin Ahmed'), 'Rahim');
  assert.equal(mask.firstNameOnly(''), 'Investor');

  const scrub = mask.scrubText('Call 01712345678 or mail rahim@example.com about NID 1990123456789');
  assert.ok(!scrub.includes('01712345678'));
  assert.ok(!scrub.includes('rahim@example.com'));
  assert.ok(!scrub.includes('1990123456789'));
});

test('log masking redacts sensitive keys deeply', () => {
  const masked = mask.maskValue({ password: 'x', nested: { totp_secret: 'abc', ok: 'keep' }, list: [{ token: 't' }] });
  assert.equal(masked.password, '***');
  assert.equal(masked.nested.totp_secret, '***');
  assert.equal(masked.nested.ok, 'keep');
  assert.equal(masked.list[0].token, '***');
});

test('CSV export is Excel friendly (BOM, CRLF, quoting)', () => {
  const content = csv.toCsv(
    [
      ['Rahim', '0171*****78', '1250.50'],
      ['Sayeed, "S"', '0172*****11', '0.00'],
    ],
    ['Name', 'Mobile', 'Amount'],
  );
  assert.ok(content.startsWith('\uFEFF'));
  assert.ok(content.includes('\r\n'));
  assert.ok(content.includes('"Sayeed, ""S"""'));
  assert.equal(csv.poishaToDecimalString(125_050), '1250.50');
  assert.match(csv.csvFilename('due-report'), /^due-report-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
});

test('pagination + sort parsing refuses unsafe columns', () => {
  assert.deepEqual(pagination.parsePagination({ page: '3', limit: '10' }), { page: 3, limit: 10, offset: 20 });
  assert.deepEqual(pagination.parsePagination({ page: '-1' }), { page: 1, limit: 25, offset: 0 });
  assert.deepEqual(pagination.parsePagination({ limit: '9999' }), { page: 1, limit: 100, offset: 0 });

  const allowed = ['name', 'created_at'];
  assert.equal(pagination.parseSort({ sort: 'name', dir: 'asc' }, allowed).sql, 'name asc');
  assert.equal(pagination.parseSort({ sort: 'name; drop table admins', dir: 'asc' }, allowed).sql, 'created_at desc');
  assert.equal(pagination.parseSort({ sort: 'created_at', dir: 'sideways' }, allowed).sql, 'created_at desc');

  assert.deepEqual(pagination.paged({ rows: [1, 2], total: 5, limit: 2, offset: 0 }).meta, {
    total: 5,
    page: 1,
    limit: 2,
    pages: 3,
    hasMore: true,
  });
});
