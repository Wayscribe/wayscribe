#!/bin/sh
# The deploy key's forced command (docs/DEMO_HOSTING.md), run through sudo:
#
#   command="sudo -n /usr/local/sbin/wayscribe-demo-deploy \"$SSH_ORIGINAL_COMMAND\"",restrict ssh-ed25519 ...
#
# Takes exactly one release tag. Checks it out, records it, and runs the reset,
# which pulls, verifies signatures and smoke-checks. Rollback is this, run for
# the previous tag; every deploy is a reset, so a database a newer release
# migrated never meets an older one.
set -eu
TAG="${1:-}"
if ! expr "${TAG}" : 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$' >/dev/null; then
  echo "usage: a release tag such as v0.3.0" >&2
  exit 2
fi

CHECKOUT=/opt/wayscribe
ENV_FILE=/etc/wayscribe-demo/env
exec 9>/run/wayscribe-demo.lock
flock -w 900 9 || {
  echo "a reset or deploy is running" >&2
  exit 1
}

git -C "${CHECKOUT}" fetch --quiet --depth 1 origin "refs/tags/${TAG}:refs/tags/${TAG}"
git -C "${CHECKOUT}" -c advice.detachedHead=false checkout --quiet "refs/tags/${TAG}"
sed -i "s/^WAYSCRIBE_VERSION=.*/WAYSCRIBE_VERSION=${TAG}/" "${ENV_FILE}"
# The env file must now name this tag, once: a missing line would leave the
# reset running the old release. Captured, then matched (no pipe to grep -q).
recorded=$(sed -n 's/^WAYSCRIBE_VERSION=//p' "${ENV_FILE}")
if [ "${recorded}" != "${TAG}" ]; then
  echo "${ENV_FILE} does not record WAYSCRIBE_VERSION=${TAG}" >&2
  exit 1
fi

WAYSCRIBE_DEMO_LOCKED=1 DEMO_ACTION=deploy exec sh "${CHECKOUT}/deploy/demo/host/reset.sh"
