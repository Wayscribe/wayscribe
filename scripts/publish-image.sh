#!/bin/sh
# Build and push multi-platform images, sign them, and only then tag them.
#
# The order is the point. Every image is pushed by digest with no tag, its SBOMs
# are attached to that digest, and the digest is signed and verified. Only when
# every image has passed are the release tag and `latest` created, pointing at
# the digests that were verified. If anything fails before that, for any of the
# images, no release tag exists for any of them: nobody can pull an unsigned
# image by its version, or a signed api beside a web image that never shipped.
#
# Usage: scripts/publish-image.sh <tag> <dockerfile>=<repository> [...]
#   e.g. scripts/publish-image.sh v1.0.0 \
#          apps/api/Dockerfile=registry.gitlab.com/jojithedev/flight-recorder/api \
#          apps/web/Dockerfile=registry.gitlab.com/jojithedev/flight-recorder/web
#
# DRY_RUN=1 does everything except the cosign calls, which it prints: the builds,
# the pushes by digest, the SBOMs, and the tags. Point it at a throwaway registry
# to rehearse a release (docs/OPERATIONS.md §11).
#
# Requires docker with a buildx builder that can push to the registry, jq, and,
# unless DRY_RUN=1, SIGSTORE_ID_TOKEN (see scripts/attest-and-sign.sh).
set -eu

TAG="${1:?usage: publish-image.sh <tag> <dockerfile>=<repository> [...]}"
shift
if [ "$#" -eq 0 ]; then
  echo "usage: publish-image.sh <tag> <dockerfile>=<repository> [...]" >&2
  exit 2
fi
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64}"
HERE=$(dirname "$0")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Phase 1: push by digest, attest, sign, verify. Nothing is tagged.
for IMAGE in "$@"; do
  DOCKERFILE=${IMAGE%%=*}
  REPOSITORY=${IMAGE#*=}
  METADATA="$WORK/metadata.json"

  # `push-by-digest` uploads the manifests without creating a tag, and
  # `name-canonical` records the repository@digest form in the metadata.
  docker buildx build \
    --platform "$(echo "$PLATFORMS" | tr ' ' ',')" \
    --file "$DOCKERFILE" \
    --output "type=image,name=$REPOSITORY,push-by-digest=true,name-canonical=true,push=true" \
    --metadata-file "$METADATA" \
    .

  DIGEST=$(jq -r '."containerimage.digest" // empty' "$METADATA")
  case "$DIGEST" in
    sha256:*) ;;
    *)
      echo "publish-image.sh: the build of $DOCKERFILE reported no image digest" >&2
      exit 1
      ;;
  esac
  echo "Pushed $REPOSITORY@$DIGEST, untagged"

  "$HERE/attest-and-sign.sh" "$REPOSITORY" "$DIGEST" "$TAG"
  echo "$REPOSITORY@$DIGEST" >> "$WORK/verified"
done

# Phase 2: every image passed, so tag them. One source that is an index makes
# imagetools create a carbon copy, so each tag names exactly the digest that was
# signed rather than a rebuilt index.
while read -r REFERENCE; do
  REPOSITORY=${REFERENCE%@*}
  DIGEST=${REFERENCE#*@}
  docker buildx imagetools create --tag "$REPOSITORY:$TAG" --tag "$REPOSITORY:latest" "$REFERENCE"
  for NAME in "$TAG" latest; do
    TAGGED=$(docker buildx imagetools inspect "$REPOSITORY:$NAME" --format '{{json .Manifest}}' | jq -r '.digest')
    if [ "$TAGGED" != "$DIGEST" ]; then
      echo "publish-image.sh: $REPOSITORY:$NAME is $TAGGED, not the signed $DIGEST" >&2
      exit 1
    fi
  done
  echo "Tagged $REPOSITORY:$TAG and :latest at $DIGEST"
done < "$WORK/verified"
