#!/bin/sh
# Run the smoke check until it passes or the deadline passes. Never unbounded.
#
#   sh deploy/demo/wait-for-smoke.sh <base-url> <deadline-seconds>
set -eu

BASE="${1:?usage: wait-for-smoke.sh <base-url> <deadline-seconds>}"
DEADLINE_SECONDS="${2:?usage: wait-for-smoke.sh <base-url> <deadline-seconds>}"
case "${DEADLINE_SECONDS}" in
  '' | *[!0-9]*)
    echo "wait-for-smoke: deadline must be whole seconds" >&2
    exit 2
    ;;
esac
HERE=$(dirname "$0")
started=$(date +%s)

while :; do
  if output=$(sh "${HERE}/smoke-check.sh" "${BASE}" 2>&1); then
    echo "${output}"
    exit 0
  fi
  now=$(date +%s)
  if [ $((now - started)) -ge "${DEADLINE_SECONDS}" ]; then
    echo "wait-for-smoke: still failing after ${DEADLINE_SECONDS}s: ${output}" >&2
    exit 1
  fi
  if [ $((now - started + 10)) -gt "${DEADLINE_SECONDS}" ]; then
    echo "wait-for-smoke: would pass the ${DEADLINE_SECONDS}s deadline: ${output}" >&2
    exit 1
  fi
  sleep 10
done
