/**
 * Seed Super Admin sync regression tests.
 *
 * The bug: changing SEED_SUPER_ADMIN_PASSWORD after the first seed had no
 * effect - the bootstrap returned early whenever an admin already existed, so
 * the stored hash was never updated and login kept failing with
 * "Invalid email or password". Seed/startup must VERIFY the env password
 * against the stored hash and re-hash on mismatch, and credentials must be
 * matched trimmed (email also lower-cased) at every boundary.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, ACCOUNTANT_PASSWORD } from './helpers/harness.js';

let ctx;
let auth;
let crypto;
let validate;

const SEED_EMAIL = 'seedroot@test.local';
const PASS1 = 'Seed#Orchid#2026!x';
const PASS2 = 'Rotated#Orchid#2026!x';

before(async () => {
  ctx = await createTestContext();
  auth = await import('../src/services/auth.service.js');
  crypto = await import('../src/services/crypto.service.js');
  validate = await import('../src/utils/validate.js');
});

after(async () => {
  await ctx?.close();
});

async function seedRow() {
  const res = await ctx.query('select * from admins where email = ?1', [SEED_EMAIL]);
  return res.rows[0] ?? null;
}

describe('credential normalisation', () => {
  test('helpers trim and lower-case', () => {
    assert.equal(validate.normalizeEmail('  Foo.Bar@Example.COM  '), 'foo.bar@example.com');
    assert.equal(validate.normalizeEmail(undefined), '');
    assert.equal(validate.normalizePasswordInput('  abc123 \n'), 'abc123');
    assert.equal(validate.normalizePasswordInput(null), '');
  });

  test('hash/verify treat padded and unpadded passwords as the same password', async () => {
    // An env password pasted with stray whitespace must still match the
    // password typed on the login form (which always trimmed its input).
    const hash = await crypto.hashPassword(`  ${PASS1}  `);
    assert.equal(await crypto.verifyPassword(PASS1, hash), true);
    assert.equal(await crypto.verifyPassword(` ${PASS1} `, hash), true);
    assert.equal(await crypto.verifyPassword(`${PASS1}y`, hash), false);
  });
});

describe('syncSeedSuperAdmin', () => {
  test('creates a normalised super admin; login tolerates padded, mixed-case input', async () => {
    const result = await auth.syncSeedSuperAdmin({
      name: 'Seed Root',
      email: '  SeedRoot@Test.Local ',
      password: `  ${PASS1} `,
    });
    assert.equal(result.created, true);
    assert.equal(result.admin.email, SEED_EMAIL, 'stored email is trimmed + lower-cased');
    assert.equal(result.admin.role, 'SUPER_ADMIN');
    assert.equal(result.admin.must_change_password, true);

    const admin = await auth.login({ email: '  SEEDROOT@test.local  ', password: ` ${PASS1}  ` }, null);
    assert.equal(admin.email, SEED_EMAIL);
    assert.equal(admin.role, 'SUPER_ADMIN');
  });

  test('re-syncing the same password is a no-op (hash untouched)', async () => {
    const before = (await seedRow()).password_hash;
    const result = await auth.syncSeedSuperAdmin({ name: 'Seed Root', email: SEED_EMAIL, password: PASS1 });
    assert.equal(result.created, false);
    assert.equal(result.updated, false);
    assert.equal(result.passwordReset, false);
    assert.equal((await seedRow()).password_hash, before);
  });

  test('a changed env password re-hashes, unlocks, reactivates, restores the role and revokes sessions', async () => {
    const loggedIn = await auth.login({ email: SEED_EMAIL, password: PASS1 }, null);
    const session = await auth.createSession(loggedIn, null);
    assert.ok(await auth.resolveSession(session.token, null), 'session is live before the sync');

    // Simulate a locked-out, disabled, demoted account.
    await ctx.query(
      `update admins set role = 'VIEWER', is_active = 0, disabled_reason = 'test',
         failed_login_count = 5, locked_until = '2999-01-01T00:00:00.000Z'
       where email = ?1`,
      [SEED_EMAIL],
    );

    const result = await auth.syncSeedSuperAdmin({ name: 'Seed Root', email: SEED_EMAIL, password: PASS2 });
    assert.equal(result.created, false);
    assert.equal(result.passwordReset, true, 'mismatched env password must be re-hashed, not skipped');
    assert.equal(result.updated, true);

    const row = await seedRow();
    assert.equal(row.role, 'SUPER_ADMIN');
    assert.equal(row.is_active, true);
    assert.equal(row.locked_until, null);
    assert.equal(row.failed_login_count, 0);
    assert.equal(row.must_change_password, true);

    assert.equal(await auth.resolveSession(session.token, null), null, 'old sessions are revoked on password reset');

    await assert.rejects(
      () => auth.login({ email: SEED_EMAIL, password: PASS1 }, null),
      /Invalid email or password/,
    );
    const admin = await auth.login({ email: SEED_EMAIL, password: PASS2 }, null);
    assert.equal(admin.email, SEED_EMAIL);

    const audit = await ctx.query(
      `select count(*) as count from audit_logs
        where action = 'PASSWORD_RESET'
          and entity_id = (select cast(id as text) from admins where email = ?1)`,
      [SEED_EMAIL],
    );
    assert.ok(audit.rows[0].count >= 1, 'the seed password sync is audited');
  });

  test('a weak replacement password is rejected without clobbering the stored hash', async () => {
    const before = (await seedRow()).password_hash;
    await assert.rejects(
      () => auth.syncSeedSuperAdmin({ name: 'Seed Root', email: SEED_EMAIL, password: 'weak' }),
      (err) => err.code === 'WEAK_PASSWORD',
    );
    assert.equal((await seedRow()).password_hash, before);
  });

  test('ensureFirstSuperAdmin syncs an existing seed admin instead of returning early', async () => {
    // Regression: the old implementation returned { created: false } whenever
    // ANY admin existed, leaving a stale password in place forever.
    const result = await auth.ensureFirstSuperAdmin({ name: 'Seed Root', email: SEED_EMAIL, password: PASS1 });
    assert.equal(result.created, false);
    assert.equal(result.passwordReset, true);
    const admin = await auth.login({ email: SEED_EMAIL, password: PASS1 }, null);
    assert.equal(admin.email, SEED_EMAIL);

    // A different email is still never created on top of an existing admin set.
    const other = await auth.ensureFirstSuperAdmin({ name: 'Other', email: 'nobody@test.local', password: PASS1 });
    assert.equal(other.created, false);
    assert.equal(await auth.findAdminByEmail('nobody@test.local'), null);
  });
});

describe('forceResetAdminPasswordByEmail (npm run reset-admin)', () => {
  test('resets any existing admin by padded/mixed-case email and keeps the role', async () => {
    const admin = await auth.forceResetAdminPasswordByEmail('  ACCOUNTS@Test.Local ', 'Reset#Ledger#2026!x');
    assert.equal(admin.role, 'ACCOUNTANT', 'a reset must not promote/demote the account');

    const loggedIn = await auth.login({ email: 'accounts@test.local', password: 'Reset#Ledger#2026!x' }, null);
    assert.equal(loggedIn.role, 'ACCOUNTANT');

    // Restore the harness password for tidiness.
    await auth.forceResetAdminPasswordByEmail('accounts@test.local', ACCOUNTANT_PASSWORD, { mustChangePassword: false });
  });

  test('throws 404 for an unknown email', async () => {
    await assert.rejects(
      () => auth.forceResetAdminPasswordByEmail('ghost@test.local', PASS1),
      (err) => err.status === 404,
    );
  });
});
