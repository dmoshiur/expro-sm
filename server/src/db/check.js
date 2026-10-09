/**
 * Database preflight: `npm run db:check`.
 * Connects to the configured database (Turso in production, a local file in dev/test),
 * reports the engine version, foreign-key enforcement and migration state.
 * Read-only apart from the FK probe, which runs inside a rolled-back transaction.
 * Never prints the database URL or the auth token.
 */
import { connectDatabase, closeDatabase, probeForeignKeys, query } from './client.js';
import { listMigrationFiles, appliedMigrations } from './migrate.js';

/** Counts rows that break the money/share rules. Run after an import: both counts must be 0. */
export async function countInvariantViolations() {
  const res = await query(`
    select
      (select count(*) from investments v
        where (select count(*) from installments i where i.investment_id = v.id) > 0
          and (select coalesce(sum(i.amount), 0) from installments i where i.investment_id = v.id) <> v.total_amount) as schedule_mismatch,
      (select count(*) from investors p
        where (select count(*) from nominees n where n.investor_id = p.id) > 0
          and (cast(round((select coalesce(sum(n.share_percent), 0) from nominees n where n.investor_id = p.id) * 100) as integer) <> 10000
               or (select count(*) from nominees n where n.investor_id = p.id) > 3)) as nominee_mismatch`);
  return { scheduleMismatch: Number(res.rows[0].schedule_mismatch), nomineeMismatch: Number(res.rows[0].nominee_mismatch) };
}

export async function runDbCheck({ write = (s) => process.stdout.write(s) } = {}) {
  const target = await connectDatabase();
  write(`Database reachable: ${target.kind} (${target.host})\n`);
  const version = await query('select sqlite_version() as version');
  write(`Engine: libSQL/SQLite ${version.rows[0].version}\n`);
  const fk = await probeForeignKeys();
  write(`Foreign keys: ${fk}\n`);

  const files = await listMigrationFiles();
  const applied = await appliedMigrations().catch(() => []);
  const done = new Set(applied.map((r) => r.filename));
  const pending = files.filter((f) => !done.has(f));
  write(`Migrations applied: ${applied.length} of ${files.length}\n`);
  if (pending.length) write(`Pending migrations: ${pending.join(', ')} (run "npm run migrate")\n`);
  const violations = await countInvariantViolations();
  write(`Invariants: schedule mismatches ${violations.scheduleMismatch}, nominee share mismatches ${violations.nomineeMismatch}\n`);
  return { target, foreignKeys: fk, pending, violations };
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  runDbCheck()
    .then((r) => {
      closeDatabase();
      const broken = r.violations.scheduleMismatch + r.violations.nomineeMismatch;
      process.exit(r.pending.length ? 2 : broken ? 3 : 0);
    })
    .catch((err) => {
      process.stderr.write(`Database check failed: ${err?.message ?? err}\n`);
      closeDatabase();
      process.exit(1);
    });
}
