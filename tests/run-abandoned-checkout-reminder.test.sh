#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

cat >"$tmp_dir/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
: "${CAPTURE_DIR:?}"
printf '%s\n' "$@" >"$CAPTURE_DIR/argv"
cat >"$CAPTURE_DIR/config"
printf '{"ok":true}\n'
MOCK
chmod +x "$tmp_dir/bin/curl"

CAPTURE_DIR="$tmp_dir" PATH="$tmp_dir/bin:$PATH" CRON_SECRET='fixture-secret-not-real' \
  "$repo_root/scripts/run-abandoned-checkout-reminder.sh" >"$tmp_dir/stdout"

if grep -Fq 'fixture-secret-not-real' "$tmp_dir/argv"; then
  echo 'secret leaked in curl argv' >&2
  exit 1
fi
grep -Fx -- '--config' "$tmp_dir/argv" >/dev/null
grep -Fx -- '-' "$tmp_dir/argv" >/dev/null
grep -F 'header = "Authorization: Bearer fixture-secret-not-real"' "$tmp_dir/config" >/dev/null
grep -F 'url = "https://www.8lakestours.com/api/cron/abandoned-checkouts"' "$tmp_dir/config" >/dev/null
grep -F '{"ok":true}' "$tmp_dir/stdout" >/dev/null

if CAPTURE_DIR="$tmp_dir" PATH="$tmp_dir/bin:$PATH" CRON_SECRET=$'bad\nsecret' \
  "$repo_root/scripts/run-abandoned-checkout-reminder.sh" >/dev/null 2>&1; then
  echo 'newline-containing secret was accepted' >&2
  exit 1
fi

echo 'run-abandoned-checkout-reminder wrapper tests passed'
