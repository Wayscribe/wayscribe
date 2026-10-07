#!/bin/sh
# Wait for a one-shot container to exit, and fail unless it exited 0. Never
# unbounded. Used for demo-history: the smoke check passes as soon as the
# pinned journey exists, so only this exit code shows a failed backfill.
#
#   sh deploy/demo/wait-for-exit.sh <container-id> <deadline-seconds>
#
# Reads `docker inspect`, not a Compose subcommand, so it works on any Compose
# version.
set -eu

ID="${1:?usage: wait-for-exit.sh <container-id> <deadline-seconds>}"
DEADLINE_SECONDS="${2:?usage: wait-for-exit.sh <container-id> <deadline-seconds>}"
case "${DEADLINE_SECONDS}" in
  '' | *[!0-9]*)
    echo "wait-for-exit: deadline must be whole seconds" >&2
    exit 2
    ;;
esac
started=$(date +%s)

while :; do
  state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "${ID}") || {
    echo "wait-for-exit: cannot inspect container ${ID}" >&2
    exit 1
  }
  case "${state}" in
    "exited 0")
      exit 0
      ;;
    exited\ * | dead\ *)
      echo "wait-for-exit: container ${ID} ended ${state}" >&2
      exit 1
      ;;
  esac
  now=$(date +%s)
  if [ $((now - started + 5)) -gt "${DEADLINE_SECONDS}" ]; then
    echo "wait-for-exit: container ${ID} still ${state} at the ${DEADLINE_SECONDS}s deadline" >&2
    exit 1
  fi
  sleep 5
done
