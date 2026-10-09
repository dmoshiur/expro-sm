/**
 * Regression: importing rows with their original updated_at must not be rewritten by the
 * search-text trigger (the bug caught by the PostgreSQL round trip). Uses the disposable test DB.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/harness.js';

let ctx;
let query;

before(async () => {
  ctx = await createTestContext();
  ({ query } = await import('../src/db/client.js'));
});

after(async () => {
  await ctx?.close();
});

test('import keeps the original updated_at when search_text is already populated', async () => {
  const stamp = '2026-01-05T12:00:00.500Z';
  await query(
    `insert into investors (id, name, mobile, status, search_text, created_at, updated_at)
     values (?1, ?2, ?3, 'ACTIVE', ?4, ?5, ?5)`,
    [900001, 'Imported Person', '01799000001', 'imported person 01799000001 ', stamp],
  );
  const row = (await query('select updated_at, search_text from investors where id = ?1', [900001])).rows[0];
  // The query layer returns *_at columns as Date objects; compare the instant.
  assert.equal(new Date(row.updated_at).toISOString(), stamp);
  assert.equal(row.search_text, 'imported person 01799000001 ');
});

test('a normal insert still fills search_text', async () => {
  await query(
    `insert into investors (id, name, mobile, address, status, created_at, updated_at)
     values (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)`,
    [900002, 'New Person', '01799000002', 'Dhaka', '2026-02-01T00:00:00.000Z'],
  );
  const row = (await query('select search_text from investors where id = ?1', [900002])).rows[0];
  assert.equal(row.search_text, 'new person 01799000002 dhaka');
});
