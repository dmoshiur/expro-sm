#!/usr/bin/env bash
# Exports the PostgreSQL portal database to CSV files for load-turso.mjs.
#
#   PG_URL='postgresql://user:pass@host:5432/db' bash tools/pg-to-turso/export-postgres.sh ./pg-export
#
# - Read-only: one REPEATABLE READ READ ONLY transaction, so every table is one snapshot.
# - Writes <table>.csv (psql CSV, header row, NULL = empty field) with columns converted
#   to the Turso representation (see tools/pg-to-turso/README.md, "Type mapping").
# - Stop the application (or enable maintenance) before running, so the snapshot is
#   the final state. This script cannot freeze writers by itself.
set -euo pipefail

: "${PG_URL:?Set PG_URL to the source PostgreSQL connection string}"
OUT="${1:-./pg-export}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TABLES=(admins sessions investors nominees investments installments payments sms_logs audit_logs job_runs)

command -v psql >/dev/null 2>&1 || { echo "psql (PostgreSQL client) is required" >&2; exit 1; }
case "$OUT" in *"'"*) echo "output directory must not contain single quotes" >&2; exit 1 ;; esac
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

PSQL=(psql "$PG_URL" -X -q -v ON_ERROR_STOP=1)
SCRIPT="$(mktemp)"
trap 'rm -f "$SCRIPT"' EXIT

{
  echo '\set ON_ERROR_STOP on'
  echo 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'
  for t in "${TABLES[@]}"; do
    cols="$("${PSQL[@]}" -A -t -v table_name="$t" -f "$HERE/export-postgres.sql")"
    if [ -z "$cols" ]; then
      echo "table '$t' was not found in the PostgreSQL public schema" >&2
      exit 1
    fi
    echo "\\copy (select $cols from $t order by 1) to '$OUT/$t.csv' csv header"
  done
  echo 'COMMIT;'
} > "$SCRIPT"

"${PSQL[@]}" -f "$SCRIPT"
echo "Exported ${#TABLES[@]} tables to $OUT"
for t in "${TABLES[@]}"; do echo "  $t.csv"; done
