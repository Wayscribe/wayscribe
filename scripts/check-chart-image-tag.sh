#!/bin/sh
# The Helm chart's default images must be the ones a release publishes.
#
# A release is a `vMAJOR.MINOR.PATCH` tag (`.release-rules` in .gitlab-ci.yml).
# publish-images pushes `api:$CI_COMMIT_TAG` and `web:$CI_COMMIT_TAG`, and
# publish-sdk refuses any tag but `v` plus packages/sdk-node's version, because
# the images and the SDK share a version. The chart used to default to its bare
# appVersion, `api:0.1.0`, a tag nothing ever pushes, so an install with the
# default values could not pull.
#
# Renders the chart with its defaults and requires every image it names from
# this project's registry to be tagged `v<sdk version>`.
#
# Usage: scripts/check-chart-image-tag.sh    (needs helm, grep, sed)
set -eu

cd "$(dirname "$0")/.."
CHART=deploy/helm/wayscribe
REGISTRY=registry.gitlab.com/jojithedev/wayscribe

VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' packages/sdk-node/package.json)
if [ -z "$VERSION" ]; then
  echo "FAIL: could not read the version from packages/sdk-node/package.json" >&2
  exit 1
fi
EXPECTED="v$VERSION"

RENDERED=$(helm template ws "$CHART" \
  --set postgresql.enabled=true \
  --set secrets.encryptionKey=0000000000000000000000000000000000000000000000000000000000000000 \
  --set secrets.adminToken=1111111111111111111111111111111111111111111111111111111111111111)

IMAGES=$(printf '%s\n' "$RENDERED" | sed -n "s#^ *image: *\"\{0,1\}\($REGISTRY/[^\"]*\)\"\{0,1\}\$#\1#p" | sort -u)
if [ -z "$IMAGES" ]; then
  echo "FAIL: the rendered chart names no image from $REGISTRY" >&2
  exit 1
fi

STATUS=0
for IMAGE in $IMAGES; do
  TAG=${IMAGE##*:}
  if [ "$TAG" = "$EXPECTED" ]; then
    echo "ok   $IMAGE"
  else
    echo "FAIL $IMAGE: a release of $VERSION publishes the tag $EXPECTED, not $TAG" >&2
    STATUS=1
  fi
done
exit "$STATUS"
