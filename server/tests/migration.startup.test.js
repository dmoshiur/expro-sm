/** Migration/startup regression tests use only disposable local libSQL files.
 * No developer .env or production credentials are read by these tests. */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

await mkdir(resolve('.tmp'), { recursive: true });
const root = await mkdtemp(resolve('.tmp/test-startup-'));
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = `file:${join(root, 'test.db')}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.LOG_LEVEL = 'silent';
process.env.JOBS_ENABLED = 'false';
process.env.SESSION_SECRET = randomBytes(48).toString('base64url');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const { query, connectDatabase, closeDatabase, resetDatabaseForTests, probeForeignKeys } = await import('../src/db/client.js');
const { runMigrations, appliedMigrations, MIGRATIONS_DIR } = await import('../src/db/migrate.js');
const { runDbCheck } = await import('../src/db/check.js');
const { logger } = await import('../src/utils/logger.js');
const initial = '001_turso_initial_schema.sql';

beforeEach(async () => {
  await connectDatabase();
  await resetDatabaseForTests(); // test-only reset, never used by the fix
  closeDatabase();
  await connectDatabase();
});
after(async () => { closeDatabase(); await rm(root, { recursive: true, force: true }); });

async function exists(name) {
  return (await query('SELECT name FROM sqlite_master WHERE name = ?1', [name])).rows.length > 0;
}
async function fixture() {
  const dir = await mkdtemp(join(root, 'migrations-'));
  await copyFile(join(MIGRATIONS_DIR, initial), join(dir, initial));
  return dir;
}

function boot({ migrate = false, listen = false } = {}) {
  return new Promise((resolveBoot, reject) => {
    const child = spawn(process.execPath, ['server/server.js'], {
      cwd: resolve('.'), env: { ...process.env, DB_MIGRATE_ON_START: String(migrate), LOG_LEVEL: 'info', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let listening = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Startup timed out: ${output}`)); }, 15000);
    const collect = (chunk) => {
      output += chunk;
      if (listen && !listening && output.includes('investor portal listening')) {
        listening = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolveBoot({ code, output, listening }); });
  });
}

test('empty database: read-only startup reports pending, metadata bootstrap is idempotent', async () => {
  const child = await boot();
  assert.equal(child.code, 1);
  assert.match(child.output, /Database schema is missing 1 migration/);
  assert.doesNotMatch(child.output, /database query failed/);
  assert.equal(await exists('schema_migrations'), false, 'verify-only path must not mutate');
  assert.deepEqual(await appliedMigrations(), []);
  assert.deepEqual(await appliedMigrations(), []);
  const columns = (await query("PRAGMA table_info('schema_migrations')")).rows.map((c) => c.name);
  assert.deepEqual(columns, ['filename', 'checksum', 'applied_at', 'duration_ms']);
  const result = await runMigrations();
  assert.deepEqual(result.applied, [initial]);
  const history = await appliedMigrations();
  assert.equal(history[0].filename, initial);
  assert.match(history[0].checksum, /^[a-f0-9]{64}$/);
  assert.ok(history[0].applied_at instanceof Date);
  assert.equal(await probeForeignKeys(), 'enforced');
  for (const name of ['admins', 'sessions', 'investors', 'nominees', 'investments', 'installments', 'payments', 'audit_logs', 'sms_logs', 'job_runs']) {
    assert.equal(await exists(name), true, name);
  }
});

test('real startup migrates an empty database, then repeat verify-only startup succeeds', async () => {
  const first = await boot({ migrate: true, listen: true });
  assert.equal(first.code, 0, first.output);
  assert.equal(first.listening, true);
  assert.match(first.output, /startup migrations applied/);
  const history = await appliedMigrations();
  const second = await boot({ listen: true });
  assert.equal(second.code, 0, second.output);
  assert.equal(second.listening, true);
  assert.deepEqual(await appliedMigrations(), history);
});

test('initialized schema and all protected data remain identical after rerun/reconnection', async () => {
  await runMigrations();
  await query("INSERT INTO admins (id, name, email, password_hash) VALUES (1, 'Admin', 'admin@test.local', 'scrypt$fixture')");
  await query("INSERT INTO sessions (admin_id, token_hash, expires_at) VALUES (1, 'fixture-hash', '2030-01-01T00:00:00.000Z')");
  await query("INSERT INTO investors (id, name, mobile) VALUES (1, 'Investor', '01799000001')");
  await query("INSERT INTO investments (id, investor_id, total_amount, installment_count) VALUES (1, 1, 10000, 1)");
  await query("INSERT INTO installments (id, investment_id, serial, amount, amount_paid, due_date) VALUES (1, 1, 1, 10000, 2500, '2030-01-01')");
  await query("INSERT INTO nominees (investor_id, name, relation, mobile, share_percent) VALUES (1, 'Nominee', 'Child', '01799000002', 100)");
  await query("INSERT INTO payments (installment_id, amount, status) VALUES (1, 2500, 'SUCCESS')");
  await query("INSERT INTO audit_logs (admin_id, action, entity) VALUES (1, 'FIXTURE', 'investors')");
  const tables = ['admins', 'sessions', 'investors', 'investments', 'installments', 'nominees', 'payments', 'audit_logs', 'schema_migrations'];
  const snapshot = async () => Promise.all(tables.map(async (t) => (await query(`SELECT * FROM ${t}`)).rows));
  const original = await snapshot();
  assert.deepEqual((await runMigrations()).skipped, [initial]);
  closeDatabase();
  await connectDatabase();
  assert.deepEqual((await runMigrations()).skipped, [initial]);
  assert.deepEqual(await snapshot(), original);
  const check = await runDbCheck({ write: () => {} });
  assert.deepEqual(check.pending, []);
  assert.deepEqual(check.violations, { scheduleMismatch: 0, nomineeMismatch: 0 });
});

test('failed file rolls back SQL and history, stops later files, and retries in order', async () => {
  const dir = await fixture();
  await writeFile(join(dir, '002_pending.sql'), "CREATE TABLE repair_test (id INTEGER); INSERT INTO repair_test VALUES (1); SELECT * FROM missing_test;");
  await writeFile(join(dir, '003_later.sql'), 'CREATE TABLE later_test (id INTEGER);');
  await assert.rejects(runMigrations({ migrationsDir: dir }), /002_pending.sql failed and was rolled back/);
  assert.deepEqual((await appliedMigrations()).map((r) => r.filename), [initial]);
  assert.equal(await exists('repair_test'), false);
  assert.equal(await exists('later_test'), false);
  await writeFile(join(dir, '002_pending.sql'), 'CREATE TABLE repair_test (id INTEGER); INSERT INTO repair_test VALUES (1);');
  assert.deepEqual((await runMigrations({ migrationsDir: dir })).applied, ['002_pending.sql', '003_later.sql']);
  assert.equal((await query('SELECT count(*) AS n FROM repair_test')).rows[0].n, 1);
  assert.equal((await runMigrations({ migrationsDir: dir })).applied.length, 0);
});

test('failed initial migration is not marked applied and retries successfully', async () => {
  const dir = await fixture();
  await writeFile(join(dir, initial), 'CREATE TABLE partial_test (id INTEGER); SELECT * FROM missing_test;');
  await assert.rejects(runMigrations({ migrationsDir: dir }), /failed and was rolled back/);
  assert.equal(await exists('partial_test'), false);
  assert.deepEqual(await appliedMigrations(), []);
  await copyFile(join(MIGRATIONS_DIR, initial), join(dir, initial));
  assert.deepEqual((await runMigrations({ migrationsDir: dir })).applied, [initial]);
});

test('verify-only startup detects checksum drift, not just filenames', async () => {
  await runMigrations();
  await query('UPDATE schema_migrations SET checksum = ?1 WHERE filename = ?2', ['wrong', initial]);
  const child = await boot();
  assert.equal(child.code, 1);
  assert.match(child.output, /checksum mismatch/);
  assert.equal(child.listening, false);
});

test('incompatible metadata is refused without altering its rows', async () => {
  await query("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT)");
  await query("INSERT INTO schema_migrations VALUES ('legacy.sql', 'original')");
  await assert.rejects(runMigrations(), /Incompatible schema_migrations columns/);
  assert.deepEqual((await query('SELECT * FROM schema_migrations')).rows, [{ filename: 'legacy.sql', checksum: 'original' }]);
});

test('existing application tables without history require review, never automatic baselining', async () => {
  await query('CREATE TABLE investors (id INTEGER PRIMARY KEY, name TEXT)');
  await query("INSERT INTO investors VALUES (1, 'Preserve me')");
  await assert.rejects(runMigrations(), /SCHEMA_WITHOUT_HISTORY/);
  await assert.rejects(runMigrations({ dryRun: true }), /SCHEMA_WITHOUT_HISTORY/);
  assert.equal(await exists('schema_migrations'), false);
  assert.deepEqual((await query('SELECT * FROM investors')).rows, [{ id: 1, name: 'Preserve me' }]);
});

test('empty database db:check reports pending without probing nonexistent app tables', async () => {
  const check = await runDbCheck({ write: () => {} });
  assert.deepEqual(check.pending, [initial]);
  assert.equal(check.foreignKeys, 'unknown');
  assert.equal(await exists('schema_migrations'), false);
  assert.equal(await exists('txn_scope'), false);
});

test('underlying errors and development logs retain safe diagnostics, never bound values', async () => {
  const { mapDbError, safeDbDiagnostics } = await import('../src/db/errors.js');
  const upstream = Object.assign(new Error('SQLITE_UNKNOWN: no such table: schema_migrations https://private.turso.io?authToken=secret bound-private-data'), {
    name: 'LibsqlError', code: 'SQLITE_UNKNOWN', cause: Object.assign(new Error('no such table: schema_migrations'), { code: 'SQLITE_ERROR', rawCode: 1 }),
  });
  const mapped = mapDbError(upstream);
  assert.equal(mapped.cause, upstream);
  assert.equal(mapped.code, 'DB_ERROR');
  const diagnostic = safeDbDiagnostics(mapped);
  assert.equal(diagnostic[1].reason, 'MISSING_TABLE');
  assert.equal(diagnostic[2].rawCode, 1);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private|bound/);
  const original = logger.error;
  let log;
  logger.error = (_message, meta) => { log = meta; };
  try {
    await assert.rejects(query("SELECT * FROM missing_test WHERE id = ?1 AND 'literal-private-data' = 'literal-private-data' -- private-comment", ['bound-private-data']));
    assert.equal(log.diagnostic[0].reason, 'MISSING_TABLE');
    assert.doesNotMatch(JSON.stringify(log), /private|bound/);
  } finally { logger.error = original; }
});

test('production configuration accepts remote Turso only, never PostgreSQL/local services', async () => {
  const { describeDatabaseTarget } = await import('../src/config/database.js');
  const env = { isProd: true, isTest: false };
  const authToken = 'placeholder-for-validation-only';
  for (const url of ['postgresql://user:pass@db.example/app', 'file:test.db', ':memory:', 'http://localhost:8080', 'libsql://127.0.0.1:8080', 'https://localhost']) {
    assert.ok(describeDatabaseTarget({ url, authToken }, env).problems.length > 0, url);
  }
  assert.deepEqual(describeDatabaseTarget({ url: 'libsql://example-org.turso.io', authToken }, env).problems, []);
});
