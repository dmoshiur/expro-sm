#!/usr/bin/env bash
#
# Logical backup of the Investor Installment Portal database (Turso / libSQL).
#
#   ./deploy/backup.sh                 # uses TURSO_DATABASE_URL from server/.env
#   STRATEGY=weekly ./deploy/backup.sh # keeps the file in the weekly set
#
# Install (02:15 Dhaka daily):
#   sudo crontab -e
#   15 2 * * * /var/www/investor-portal/deploy/backup.sh >> /var/log/investor-portal/backup.log 2>&1
#
# Restore (rehearse this on a staging database, not production):
#   turso db shell <db> < /var/backups/investor-portal/investor-portal-xxx.sql
#
# Implementation: uses the Turso CLI when it is installed and points at a remote
# database (server-side dump, no round trips), otherwise falls back to the
# dependency-free `npm run db:backup` script (schema + INSERTs as plain SQL).
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/server/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/investor-portal}"
STRATEGY="${STRATEGY:-daily}"
KEEP_DAILY="${KEEP_DAILY:-14}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

DB_URL="${TURSO_DATABASE_URL:-${DATABASE_URL:?TURSO_DATABASE_URL or DATABASE_URL must be set}}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
FILE="$BACKUP_DIR/investor-portal-$STAMP.sql"
export TURSO_DATABASE_URL="$DB_URL"

echo "[$(date -Is)] dumping database -> $FILE"
if [[ "$DB_URL" != file:* ]] && command -v turso >/dev/null 2>&1; then
  # `turso db dump` runs inside the database and needs the CLI to be logged in.
  turso db dump "${TURSO_DB_NAME:-investor-portal}" --output "$FILE"
else
  ( cd "$ROOT_DIR/server" && npm run --silent db:backup -- --out "$FILE" )
fi

sha256sum "$FILE" > "$FILE.sha256"

if [[ "$STRATEGY" == "weekly" ]]; then
  ln -sf "$FILE" "$BACKUP_DIR/latest-weekly.sql"
fi
ln -sf "$FILE" "$BACKUP_DIR/latest.sql"

# Keep only the N most recent backups (`.sha256` sidecars are pruned with them).
prune() {
  local pattern="$1" keep="$2"
  mapfile -t files < <(ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null | grep -v '\.sha256$' || true)
  if (( ${#files[@]} > keep )); then
    for old in "${files[@]:keep}"; do
      echo "[$(date -Is)] pruning $old"
      rm -f "$old" "$old.sha256"
    done
  fi
}
prune 'investor-portal-*.sql' "$KEEP_DAILY"

echo "[$(date -Is)] backup complete: $(du -h "$FILE" | cut -f1)"
echo "[$(date -Is)] verify with: head -20 '$FILE'"
