#!/usr/bin/env bash
# External scheduler wrapper for the 8 Lakes post-submit reminder endpoint.
# Required environment: REMINDER_CRON_URL and CRON_SECRET. Do not place either
# value in this repository, scheduler command line, or scheduler logs.
set -euo pipefail

: "${REMINDER_CRON_URL:?REMINDER_CRON_URL must be the HTTPS abandoned-checkouts endpoint}"
: "${CRON_SECRET:?CRON_SECRET must be injected by the scheduler secret store}"

case "$REMINDER_CRON_URL" in
  https://*) ;;
  *) printf '%s\n' 'REMINDER_CRON_URL must use HTTPS' >&2; exit 64 ;;
esac

# No dry_run parameter: this is the customer-send schedule after the separately
# documented rollout gates are intentionally opened. curl emits no secret value.
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 55 \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  --header 'Accept: application/json' \
  "$REMINDER_CRON_URL"
printf '\n'
