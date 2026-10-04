#!/usr/bin/env bash
#
# Logical backup of the Investor Installment Portal database.
#
#   ./deploy/backup.sh                 # uses DATABASE_URL from server/.env
#   STRATEGY=weekly ./deploy/backup.sh # keeps the file in the weekly set
#
# Install (02:15 Dhaka daily):
#   sudo crontab -e
#   15 2 * * * /var/www/investor-portal/deploy/backup.sh >> /var/log/investor-portal/backup.log 2>&1
#
# Restore (rehearse this on a staging database, not production):
#   pg_restore --clean --if-exists -d "$DIRECT_URL" /var/backups/investor-portal/xxx.dump
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/server/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/investor-portal}"
STRATEGY="${STRATEGY:-daily}"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
PG_DUMP="${PG_DUMP:-pg_dump}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Prefer the direct connection for dumps; the pooler can time out on long reads.
DB_URL="${DIRECT_URL:-${DATABASE_URL:?DATABASE_URL or DIRECT_URL must be set}}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
FILE="$BACKUP_DIR/investor-portal-$STAMP.dump"

echo "[$(date -Is)] dumping database -> $FILE"
"$PG_DUMP" "$DB_URL" --format=custom --no-owner --no-privileges --file="$FILE"
sha256sum "$FILE" > "$FILE.sha256"

if [[ "$STRATEGY" == "weekly" ]]; then
  ln -sf "$FILE" "$BACKUP_DIR/latest-weekly.dump"
fi
ln -sf "$FILE" "$BACKUP_DIR/latest.dump"

# retention
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
prune 'investor-portal-*.dump' "$KEEP_DAILY"

echo "[$(date -Is)] backup complete: $(du -h "$FILE" | cut -f1)"
echo "[$(date -Is)] verify with: pg_restore --list '$FILE' | head"
