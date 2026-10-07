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
    action="${DEMO_ACTION:-reset}"
    if [ "${action}" = "deploy" ]; then
      next="See the deploy-demo job log."
    else
      next="A nightly reset retries every 30 minutes, up to three times. journalctl -u wayscribe-demo-reset"
    fi
    notify "Demo ${action} failed" \
      "${action} of ${WAYSCRIBE_VERSION} failed at $(date -u +%H:%M) UTC. ${next}"
  fi
}
trap on_exit EXIT
# dash skips the EXIT trap when a signal kills it, and systemd's
# TimeoutStartSec stops a hung reset with SIGTERM: exit instead, so the EXIT
# trap runs and the timeout is alerted like any other failure.
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

demo_compose pull --quiet --ignore-buildable
verify_images "${WAYSCRIBE_VERSION}"
demo_compose build caddy visit-notifier
demo_compose down --volumes --remove-orphans
demo_compose up --detach
sh "${DEMO_CHECKOUT}/deploy/demo/wait-for-smoke.sh" "$(site_url)" 600
