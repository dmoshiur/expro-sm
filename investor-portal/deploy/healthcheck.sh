#!/usr/bin/env bash
# Simple external healthcheck for cron/monitoring: exits non-zero when the API
# or the database probe fails, so uptime monitors and cron alerting can act.
set -euo pipefail
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
response="$(curl -fsS --max-time 10 "$BASE_URL/api/health")"
echo "$response"
[[ "$response" == *'"database":"up"'* ]] || { echo "database probe failed" >&2; exit 1; }
