#!/bin/sh
# Every 5 minutes (systemd). Alerts when the demo goes down and when it comes
# back, not on every failed check. Skips while a reset or deploy runs: those
# report their own failures.
set -eu
. "$(dirname "$0")/lib.sh"
DOWN_MARKER=/run/wayscribe-demo.down

exec 9>"${DEMO_LOCK}"
flock -n 9 || exit 0
load_env

if output=$(sh "${DEMO_CHECKOUT}/deploy/demo/smoke-check.sh" "$(site_url)" 2>&1); then
  if [ -e "${DOWN_MARKER}" ]; then
    rm -f "${DOWN_MARKER}"
    notify "Demo recovered" "${output}"
  fi
  exit 0
fi

if [ ! -e "${DOWN_MARKER}" ]; then
  : >"${DOWN_MARKER}"
  notify "Demo is down" "${output}"
fi
exit 1
