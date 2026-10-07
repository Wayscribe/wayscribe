#!/bin/sh
# Rebuild the demo from nothing: the nightly reset (systemd), and the second
# half of every deploy (deploy.sh). Pull, verify signatures, rebuild Caddy and
# the notifier, wipe every volume, start, and wait for the smoke check.
set -eu
. "$(dirname "$0")/lib.sh"

if [ "${WAYSCRIBE_DEMO_LOCKED:-}" != "1" ]; then
  exec 9>"${DEMO_LOCK}"
  flock -w 900 9 || {
    echo "another reset or deploy holds ${DEMO_LOCK}" >&2
    exit 1
  }
fi
load_env

on_exit() {
  status=$?
  if [ "${status}" -ne 0 ]; then
    notify "Demo ${DEMO_ACTION:-reset} failed" \
      "${DEMO_ACTION:-reset} of ${WAYSCRIBE_VERSION} failed at $(date -u +%H:%M) UTC. A nightly reset retries every 30 minutes, up to three times. journalctl -u wayscribe-demo-reset"
  fi
}
trap on_exit EXIT

demo_compose pull --quiet --ignore-buildable
verify_images "${WAYSCRIBE_VERSION}"
demo_compose build caddy visit-notifier
demo_compose down --volumes --remove-orphans
demo_compose up --detach
sh "${DEMO_CHECKOUT}/deploy/demo/wait-for-smoke.sh" "$(site_url)" 600
