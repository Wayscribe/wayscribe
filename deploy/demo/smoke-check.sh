#!/bin/sh
# The public demo's smoke check, shared by the CI overlay job, the deploy job,
# the nightly reset and the uptime timer (docs/DEMO_HOSTING.md).
#
#   sh deploy/demo/smoke-check.sh https://demo.wayscribe.dev
#
# Loads the home page through Caddy, searches +1 555 0100 through the web app,
# and opens the pinned failed journey on its transform step, where the phone
# diff is. Sends a fixed User-Agent so the visit notifier does not count it.
#
# No `cmd | grep -q`: under pipefail that reports false failures when grep
# exits early. Every response is captured, then matched with `case`.
set -eu

BASE="${1:?usage: smoke-check.sh <base-url>}"
BASE="${BASE%/}"
USER_AGENT="wayscribe-smoke/1"
PINNED_PHONE="+1 555 0100"
PINNED_QUERY="%2B1%20555%200100"
# apps/demo/src/history.ts: PINNED_JOURNEY_ID and PINNED_TRANSFORM_EVENT_ID.
# tests/demo-overlay.test.ts fails if these drift from it.
PINNED_JOURNEY_ID="jrn_demo_pinned_5550100"
PINNED_TRANSFORM_EVENT_ID="evt_demo_pinned_5550100_transform"

JAR=$(mktemp)
trap 'rm -f "${JAR}"' EXIT

fail() {
  echo "smoke-check: $1" >&2
  exit 1
}

fetch() {
  curl --silent --show-error --fail --location --max-time 20 \
    --user-agent "${USER_AGENT}" --cookie "${JAR}" --cookie-jar "${JAR}" "$1"
}

home=$(fetch "${BASE}/") || fail "the home page did not load from ${BASE}/"
case "${home}" in
  *"Public demo. Read-only, sample data."*) ;;
  *) fail "the home page has no demo banner" ;;
esac

results=$(fetch "${BASE}/?q=${PINNED_QUERY}") || fail "the search for ${PINNED_PHONE} did not load"
case "${results}" in
  *"${PINNED_JOURNEY_ID}"*) ;;
  *) fail "the search for ${PINNED_PHONE} did not list ${PINNED_JOURNEY_ID}" ;;
esac

journey=$(fetch "${BASE}/journeys/${PINNED_JOURNEY_ID}?event=${PINNED_TRANSFORM_EVENT_ID}") ||
  fail "the pinned journey did not load"
case "${journey}" in
  *"What changed"*) ;;
  *) fail "the pinned journey's transform step shows no diff" ;;
esac
case "${journey}" in
  *"${PINNED_PHONE}"*) ;;
  *) fail "the diff does not show ${PINNED_PHONE}" ;;
esac

echo "smoke-check: ok ${BASE}"
