# Database startup and migration safety

## Startup failure traced

The server validates configuration, opens the singleton libSQL client and runs
`SELECT 1`. With the production default `DB_MIGRATE_ON_START=false`, the old
startup path called `appliedMigrations()` directly. That function selected
`filename, checksum, applied_at` without calling the runner's metadata bootstrap.
Only `runMigrations()` created `schema_migrations`. A successful connection did
not imply that this table existed.

This was reproduced on a fresh disposable libSQL file: the underlying
`LibsqlError` says `SQLITE_ERROR: no such table: schema_migrations`, wrapped as
`DB_ERROR`. The deployment's `SQLITE_UNKNOWN` alone cannot distinguish a missing
table, missing column, or another driver failure; no production database was
inspected or modified during this fix. Driver codes can vary by transport. The
original cause remains attached, and development query logs now retain a bounded,
allowlisted cause chain with driver codes, numeric raw codes, and a reason such
as `MISSING_TABLE` or `MISSING_COLUMN`. Raw messages/args/stacks are deliberately
not copied into these diagnostics. SQL log previews strip literals and comments.
Production logs still use normalized errors, not upstream messages.

## Correct execution order

1. Validate the remote Turso target and credentials.
2. Connect using the single process-wide `@libsql/client` and `SELECT 1`.
3. Apply migrations explicitly (`npm run migrate`) or opt into startup application.
   The apply runner creates metadata with `CREATE TABLE IF NOT EXISTS`, validates
   its columns, reads history, sorts all migration files, checks checksums, and
   runs each pending file in its own write transaction. A second history check
   inside the transaction prevents duplicate application by concurrent runners.
   The SQL must succeed before inserting history; commit must succeed before
   reporting application. An error rolls back and aborts subsequent files.
4. Verify-only startup uses the same runner in read-only mode. A missing metadata
   table on an empty database means pending migrations, not success. Checksum
   drift or incompatible metadata fails startup.
5. Only after migrations are current, probe foreign keys, build the Express app,
   listen and start jobs. `db:check` also checks migration state before probing
   application tables and does not catch and ignore history-query failures.

CLI migration and server startup import the same `client.js`, use the same
configuration names, and never open a separate schema client. The application
transaction mechanism and its deferred installment/nominee checks are unchanged.
The sole migration, `001_turso_initial_schema.sql`, has not been edited (avoids
checksum drift); its complete tables, indexes, triggers and helper tables execute
successfully on a fresh libSQL database.

Metadata contract: `filename TEXT PRIMARY KEY`, `checksum TEXT NOT NULL`,
`applied_at TEXT NOT NULL DEFAULT (strftime(...))`,
`duration_ms INTEGER NOT NULL DEFAULT 0`. The runner validates these before reads.
History listing selects `filename, checksum, applied_at`; checksum recheck selects
`checksum` by `filename`; inserts supply `filename, checksum, duration_ms` and
use the timestamp default. The optional import tool reads only `filename` and
requires a migrated target. The initial SQL does not create a conflicting
metadata table.

## Stop conditions / operator approval

No automatic repair is attempted for incompatible metadata or application tables
without migration history. Nothing is dropped, reset, deleted, baselined or
marked applied by guessing. Normal repair does not seed admins/sample data or
change encryption/session keys, payments, money calculations, or audit records.

If `SCHEMA_WITHOUT_HISTORY` or incompatible-column validation occurs in Render:

1. Stop deployment. Take a provider-supported backup/snapshot under your normal
   production procedure.
2. With read-only access inspect `sqlite_master`,
   `PRAGMA table_info('schema_migrations')`, the history rows (if present), and
   the application table/index/trigger definitions. Do not export personal or
   credential data into deployment logs or chat.
3. Compare the definitions with the exact deployed migration files and recover
   the original migration history/checksums from a trusted backup if possible.
4. Any metadata restoration, column alteration, or approved baseline requires a
   reviewed, exact repair plan and explicit approval. This code does not perform
   those actions. Never insert a migration row merely because some tables exist.

Tests are against isolated local libSQL databases, including real server startup,
not a live Turso service. Remote production verification must use Render's
existing environment; this sandbox has no production credentials or Turso host
network access. See README for exact Render build/migrate/start commands.
