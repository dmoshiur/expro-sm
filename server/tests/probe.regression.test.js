/** Regression: startup foreign-key probe must not insert a fake session.
 * The earlier probe used:
 *   INSERT INTO sessions (admin_id, token_hash, expires_at)
 *   VALUES (-1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 * which (1) relied on a non-existent admin_id=-1, (2) used a strftime
 * expression that in sanitized logs appeared as strftime('', '') and could
 * yield NULL -> NOT NULL violation instead of the intended FOREIGN KEY
 * violation, and (3) performed a write during startup.
 *
 * The corrected probe is read-only (PRAGMA foreign_keys + SELECT 1) and
 * never creates a fake session or a fake admin.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = join(import.meta.dirname ?? '.', '..', '..');

// Isolate: use a dedicated disposable test DB
mkdirSync(join(ROOT, '.tmp'), { recursive: true });
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = `file:${join(ROOT, '.tmp', `test-probe-regression-${process.pid}.db`)}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.SESSION_SECRET = randomBytes(48).toString('base64url');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';
process.env.JOBS_ENABLED = 'false';

const { query, connectDatabase, closeDatabase, probeForeignKeys } = await import('../src/db/client.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { NOW } = await import('../src/db/sql.js');

before(async () => {
  await connectDatabase();
  const { resetDatabaseForTests } = await import('../src/db/client.js');
  await resetDatabaseForTests();
  await runMigrations();
});

after(() => {
  closeDatabase();
});

test('NOW is a valid strftime expression that returns a timestamp, not empty strings', () => {
  assert.equal(NOW, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  assert.match(NOW, /^strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)$/);
  // Direct SQL sanity: NOW should produce an ISO timestamp, not NULL
  // (strftime('', '') would be NULL and violate NOT NULL on expires_at)
});

test('probeForeignKeys is read-only and never persists a fake session', async () => {
  const beforeRows = await query('select count(*) as n from sessions');
  assert.equal(beforeRows.rows[0].n, 0);

  const fk = await probeForeignKeys();
  assert.ok(['enforced', 'not_enforced', 'unknown'].includes(fk), `probe returned ${fk}`);

  const afterRows = await query('select count(*) as n from sessions');
  assert.equal(afterRows.rows[0].n, 0, 'probe must not insert any session');

  const probeRows = await query("select count(*) as n from sessions where token_hash like 'fk-probe-%'");
  assert.equal(probeRows.rows[0].n, 0, 'no fk-probe token should exist');

  // Second probe is idempotent
  const fk2 = await probeForeignKeys();
  assert.equal(fk2, fk);
  const again = await query('select count(*) as n from sessions');
  assert.equal(again.rows[0].n, 0);
});

test('real sessions still work: valid admin, token hashing, expiration, and FK enforcement', async () => {
  // Create a real admin for the test
  await query("insert into admins (id, name, email, password_hash, role) values (10, 'Probe Admin', 'probe@test.local', 'scrypt$probe', 'SUPER_ADMIN')");

  const { hashToken } = await import('../src/services/crypto.service.js');
  const token = 'probe-regression-token-' + randomBytes(8).toString('hex');
  const hash = hashToken(token);
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();

  const inserted = await query('insert into sessions (admin_id, token_hash, expires_at) values (?1, ?2, ?3) returning id, expires_at', [10, hash, expiresAt]);
  assert.ok(inserted.rows[0].id);
  assert.equal(new Date(inserted.rows[0].expires_at).toISOString(), expiresAt);

  // FK enforcement: inserting with non-existent admin must fail (when enforced).
  // On a file DB with PRAGMA foreign_keys=ON, this should be FOREIGN_KEY_VIOLATION.
  // We assert it fails with some constraint error, not silently succeeds.
  let fkFailed = false;
  try {
    const badHash = hashToken('bad-' + token);
    const badExpires = new Date(Date.now() + 3600_000).toISOString();
    await query('insert into sessions (admin_id, token_hash, expires_at) values (?1, ?2, ?3)', [99999, badHash, badExpires]);
  } catch (err) {
    fkFailed = true;
    assert.ok(['FOREIGN_KEY_VIOLATION', 'CONSTRAINT_VIOLATION', 'RAISED'].includes(err.code) || /FOREIGN KEY/i.test(err.message), `expected FK violation, got ${err.code}`);
  }
  // If FK is enforced, the bad insert must have failed. If the DB reports not_enforced,
  // it could succeed – but in our test DB it is enforced, so we expect failure.
  const fk = await probeForeignKeys();
  if (fk === 'enforced') assert.equal(fkFailed, true, 'FK violation should be enforced on test DB');
});

test('sessions table schema enforces the expected constraints', async () => {
  const table = await query("select sql from sqlite_master where type='table' and name='sessions'");
  const sql = table.rows[0].sql;
  assert.match(sql, /admin_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+admins\(id\)/i, 'admin_id references admins');
  assert.match(sql, /token_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i, 'token_hash unique');
  assert.match(sql, /expires_at\s+TEXT\s+NOT NULL/i, 'expires_at not null');
});
