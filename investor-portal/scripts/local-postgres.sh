#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Dev-only helper: boots a REAL PostgreSQL server locally, no Docker and no
# root required, using the `pgserver` pip package (bundles official PG binaries).
#
#   ./scripts/local-postgres.sh start|stop|status|psql
#
# PGDATA_DIR  (default /tmp/investor-portal-pgdata)  - intentionally outside the repo
# PGPORT      (default 5432)                        - TCP 127.0.0.1, trust auth
#
# PRODUCTION uses Supabase (see README.md) - this helper is only for local
# development and the automated test suite.
# ---------------------------------------------------------------------------
set -euo pipefail

PGDATA_DIR="${PGDATA_DIR:-/tmp/investor-portal-pgdata}"
PGPORT="${PGPORT:-5432}"
DB_NAME="${DB_NAME:-investor_portal}"
TEST_DB_NAME="${TEST_DB_NAME:-investor_portal_test}"
LOG="$PGDATA_DIR/server.log"

find_bin() {
  local d
  for d in "$(python3 -c 'import pgserver,os;print(os.path.join(os.path.dirname(pgserver.__file__),"pginstall","bin"))' 2>/dev/null || true)"; do
    [ -x "$d/pg_ctl" ] && { echo "$d"; return 0; }
  done
  echo "installing pgserver via pip ..." >&2
  pip3 install --break-system-packages --quiet --user pgserver >&2
  local p
  p="$(python3 -c 'import pgserver,os;print(os.path.join(os.path.dirname(pgserver.__file__),"pginstall","bin"))')"
  echo "$p"
}

PG_BIN="$(find_bin)"
export PATH="$PG_BIN:$PATH"

running() { "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q >/dev/null 2>&1; }

start() {
  if running; then echo "postgres already running on 127.0.0.1:$PGPORT"; return 0; fi
  if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
    echo "initdb -> $PGDATA_DIR"
    mkdir -p "$PGDATA_DIR"
    "$PG_BIN/initdb" -D "$PGDATA_DIR" -U postgres --auth-local=trust --auth-host=trust -E UTF8 >/dev/null
    {
      echo "listen_addresses = '127.0.0.1'"
      echo "port = $PGPORT"
      echo "fsync = off"
      echo "synchronous_commit = off"
      echo "full_page_writes = off"
      echo "max_connections = 100"
    } >> "$PGDATA_DIR/postgresql.conf"
  fi
  "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -l "$LOG" -w -t 60 start >/dev/null
  for db in "$DB_NAME" "$TEST_DB_NAME"; do
    if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -lqt | cut -d'|' -f1 | grep -qw "$db"; then
      "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U postgres "$db"
    fi
  done
  echo "postgres ready: postgresql://postgres:postgres@127.0.0.1:$PGPORT/$DB_NAME (db: $DB_NAME, $TEST_DB_NAME)"
}

stop()  { running && "$PG_BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null && echo stopped || echo "not running"; }
status(){ running && "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB_NAME" -c "select version();" || { echo "not running"; exit 1; }; }

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  psql) shift; "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB_NAME" "$@" ;;
  *) echo "usage: $0 [start|stop|status|psql]"; exit 1 ;;
esac
