#!/usr/bin/env bash
# External scheduler wrapper for the 8 Lakes post-submit reminder endpoint.
# CRON_SECRET must be injected by the scheduler secret store; it is supplied to
# curl through stdin configuration, never in a command-line argument or URL.
set -euo pipefail

readonly REMINDER_CRON_URL='https://www.8lakestours.com/api/cron/abandoned-checkouts'
: "${CRON_SECRET:?CRON_SECRET must be injected by the scheduler secret store}"
case "$CRON_SECRET" in
  *$'\n'*|*$'\r'*) printf '%s\n' 'CRON_SECRET must not contain a newline' >&2; exit 64 ;;
esac

# No dry_run parameter: this is the customer-send schedule after the separately
# documented rollout gates are intentionally opened. `--config -` reads the
# Authorization header from stdin, so it does not appear in curl's argv.
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 55 --config - <<EOF
header = "Authorization: Bearer ${CRON_SECRET}"
header = "Accept: application/json"
url = "${REMINDER_CRON_URL}"
EOF
printf '\n'
