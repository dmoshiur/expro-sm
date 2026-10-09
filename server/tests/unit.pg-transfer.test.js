/** PostgreSQL -> Turso transfer: CSV parsing and value conversion (pure functions). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../tools/pg-to-turso/csv.mjs';
import { convertValue, buildBatches } from '../../tools/pg-to-turso/convert.mjs';

test('csv: unquoted empty is NULL, quoted empty is the empty string', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,,""\n'), [['a', 'b', 'c'], ['1', null, '']]);
});

test('csv: quotes, commas and embedded newlines inside quoted fields', () => {
  const rows = parseCsv('x,y\n"say ""hi"", ok","line1\nline2"\n');
  assert.deepEqual(rows[1], ['say "hi", ok', 'line1\nline2']);
});

test('csv: CRLF line endings and a missing trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('convert: booleans become 0/1, numerics become numbers, bytea hex becomes a Buffer', () => {
  assert.equal(convertValue('t', { name: 'is_active', type: 'INTEGER' }, 'x'), 1);
  assert.equal(convertValue('0', { name: 'totp_enabled', type: 'INTEGER' }, 'x'), 0);
  assert.equal(convertValue('60.00', { name: 'share_percent', type: 'REAL' }, 'x'), 60);
  assert.deepEqual(convertValue('00ff10', { name: 'photo', type: 'BLOB' }, 'x'), Buffer.from([0, 255, 16]));
});

test('convert: timestamps and dates are validated against the Turso text format', () => {
  assert.equal(convertValue('2026-01-05T12:00:00.500Z', { name: 'created_at', type: 'TEXT' }, 'x'), '2026-01-05T12:00:00.500Z');
  assert.throws(() => convertValue('2026-01-05 12:00:00+00', { name: 'created_at', type: 'TEXT' }, 'x'), /not a UTC ISO timestamp/);
  assert.throws(() => convertValue('05/01/2026', { name: 'due_date', type: 'TEXT' }, 'x'), /YYYY-MM-DD/);
});

test('convert: unsafe integers and non-hex bytea are rejected, not truncated', () => {
  assert.throws(() => convertValue('9007199254740993', { name: 'amount', type: 'INTEGER' }, 'x'), /safe integer/);
  assert.throws(() => convertValue('zz', { name: 'photo', type: 'BLOB' }, 'x'), /hex/);
});

test('batches: numbered placeholders, and a column missing from the schema is an error', () => {
  const cols = [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }];
  const b = buildBatches('admins', { header: ['id', 'name'], rows: [['1', 'A'], ['2', null]] }, cols);
  assert.match(b.batches[0].sql, /VALUES \(\?1, \?2\), \(\?3, \?4\)$/);
  assert.deepEqual(b.batches[0].params, [1, 'A', 2, null]);
  assert.throws(() => buildBatches('admins', { header: ['nope'], rows: [] }, cols), /does not have/);
});
