#!/usr/bin/env node
/**
 * Loads CSV files produced by export-postgres.sh into an EMPTY, migrated Turso database.
 *
 *   node --env-file-if-exists=.env tools/pg-to-turso/load-turso.mjs --dir ./pg-export          # dry run (default)
 *   node --env-file-if-exists=.env tools/pg-to-turso/load-turso.mjs --dir ./pg-export --apply  # load
 *
 * Uses the same TURSO_DATABASE_URL / TURSO_AUTH_TOKEN as the server (run with the server's env).
 *
 * Safety:
 *  - Dry run is the default. It parses and converts every row and reads the target,
 *    but writes nothing.
 *  - Refuses to load when the migration 001 is not applied, or when any app table already has rows.
 *  - The whole load is one write transaction. Foreign keys are deferred to commit and
 *    the application's deferred invariant checks run before COMMIT (same path as the
 *    server). Any violation rolls everything back.
 *  - Values are converted by the TARGET column type, so a mismatch fails loudly.
 */
// Parents before children. Self-references (admins.created_by, sessions.rotated_from) are
// covered by PRAGMA defer_foreign_keys inside the transaction.
import { TABLES, REQUIRED_MIGRATION, readExport, buildBatches, fail } from './convert.mjs';
import { resolve } from 'node:path';
import { connectDatabase, closeDatabase, databaseDescription, query, withTransaction } from '../../server/src/db/client.js';
import { countInvariantViolations } from '../../server/src/db/check.js';

function parseArgs(argv) {
  const opts = { dir: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--apply') opts.apply = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

/** Scalar result of a single-value query (rows are objects keyed by column name). */
async function scalar(sql) {
  const res = await query(sql);
  return Object.values(res.rows[0])[0];
}

async function targetColumns(table) {
  const res = await query(`select name, type from pragma_table_info('${table}')`);
  return res.rows.map((r) => ({ name: r.name, type: r.type ?? '' }));
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.dir) {
    console.log('Usage: node tools/pg-to-turso/load-turso.mjs --dir <export-dir> [--apply]');
    return 0;
  }
  const dir = resolve(opts.dir);

  console.log(`Target: ${databaseDescription()}`);
  await connectDatabase();

  const applied = await query('select filename from schema_migrations');
  if (!applied.rows.some((r) => r.filename === REQUIRED_MIGRATION)) {
    fail(`Migration ${REQUIRED_MIGRATION} is not applied to the target. Run "npm run migrate" first.`);
  }

  const data = readExport(dir);
  const plans = [];
  for (const table of TABLES) {
    const count = Number(await scalar(`select count(*) from ${table}`));
    if (count > 0) fail(`Target table ${table} already has ${count} rows. The loader only loads into an empty database.`);
    const plan = buildBatches(table, data.get(table), await targetColumns(table));
    plans.push({ table, rows: data.get(table).rows.length, plan });
    console.log(`  ${table.padEnd(13)} ${String(data.get(table).rows.length).padStart(7)} rows  (${plan.batches.length} batches)`);
  }

  if (!opts.apply) {
    console.log('\nDry run: every row converted and the target is empty. Nothing was written. Re-run with --apply to load.');
    return 0;
  }

  await withTransaction(async () => {
    await query('PRAGMA defer_foreign_keys = ON');
    for (const { table, plan } of plans) {
      for (const batch of plan.batches) await query(batch.sql, batch.params);
      console.log(`  loaded ${table}`);
    }
    const v = await countInvariantViolations();
    if (v.scheduleMismatch || v.nomineeMismatch) {
      fail(`Invariant violations in the imported data (schedule ${v.scheduleMismatch}, nominee ${v.nomineeMismatch}). Nothing was committed.`);
    }
  });

  console.log('\nCommitted. Verifying row counts:');
  let ok = true;
  for (const { table, rows } of plans) {
    const got = Number(await scalar(`select count(*) from ${table}`));
    const same = got === rows;
    ok = ok && same;
    console.log(`  ${table.padEnd(13)} csv ${rows}  turso ${got}  ${same ? 'OK' : 'MISMATCH'}`);
  }
  return ok ? 0 : 1;
}

// Run only when executed directly (the module is also imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main()
    .then((code) => {
      closeDatabase();
      process.exitCode = code;
    })
    .catch((err) => {
      closeDatabase();
      console.error(`Load failed: ${err.message}`);
      process.exitCode = 1;
    });
}
