#!/bin/sh
# Attach an SBOM to each platform of a pushed image, sign it keylessly, and
# verify both the way an operator will.
#
# Run by scripts/publish-image.sh between pushing an image by digest and tagging
# it. Signing uses GitLab's OIDC token (`id_tokens: SIGSTORE_ID_TOKEN` with
# `aud: sigstore`), which cosign reads from the environment, so there is no
# signing key to hold or leak. The certificate Fulcio issues names this
# project's pipeline file and the tag it ran for, which is what an operator
# verifies against (docs/OPERATIONS.md §11).
#
# Usage: scripts/attest-and-sign.sh <repository> <index-digest> <tag>
#
# DRY_RUN=1 resolves the platform digests and generates every SBOM, then prints
# the cosign commands instead of running them. Signing cannot be rehearsed for
# real without publishing: a signature is pushed beside the image and recorded
# in the public transparency log.
#
# Requires docker (with buildx), jq, and, unless DRY_RUN=1, SIGSTORE_ID_TOKEN and
# a `docker login` to the registry.
set -eu

REPOSITORY="${1:?usage: attest-and-sign.sh <repository> <index-digest> <tag>}"
INDEX_DIGEST="${2:?usage: attest-and-sign.sh <repository> <index-digest> <tag>}"
TAG="${3:?usage: attest-and-sign.sh <repository> <index-digest> <tag>}"
DRY_RUN="${DRY_RUN:-0}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64}"
OUT_DIR="${SBOM_DIR:-sboms}"

# Always this cosign, never one found on PATH: the version that signs a release
# is part of what the release claims. Update the version and digest together:
# `docker buildx imagetools inspect ghcr.io/sigstore/cosign/cosign:<version>`.
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8"

# The identity an operator will verify with. On GitLab.com the certificate's
# subject is the pipeline file at the ref it ran for; the double slash before
# .gitlab-ci.yml is part of the format.
ISSUER="${CI_SERVER_URL:-https://gitlab.com}"
IDENTITY="${ISSUER}/${CI_PROJECT_PATH:-jojithedev/flight-recorder}//.gitlab-ci.yml@refs/tags/${TAG}"

HERE=$(dirname "$0")
COSIGN=""

cosign_cmd() {
  if [ "$DRY_RUN" = "1" ]; then
    # stderr, so a caller redirecting the real output does not hide the plan.
    echo "  dry run: cosign $*" >&2
    return 0
  fi
  "$COSIGN" "$@"
}

if [ "$DRY_RUN" != "1" ]; then
  if [ -z "${SIGSTORE_ID_TOKEN:-}" ]; then
    echo "SIGSTORE_ID_TOKEN is not set. The job needs id_tokens: SIGSTORE_ID_TOKEN with aud: sigstore." >&2
    exit 1
  fi
  # The static binary, copied out of the pinned image and run here rather than
  # as a container, so it reads this job's `docker login` (under $HOME, not the
  # build directory) and SIGSTORE_ID_TOKEN directly, with nothing forwarded.
  COSIGN_DIR=$(mktemp -d)
  trap 'rm -rf "$COSIGN_DIR"' EXIT
  CONTAINER=$(docker create "$COSIGN_IMAGE")
  docker cp "$CONTAINER:/ko-app/cosign" "$COSIGN_DIR/cosign"
  docker rm "$CONTAINER" > /dev/null
  COSIGN="$COSIGN_DIR/cosign"
  "$COSIGN" version | grep GitVersion
fi

MANIFEST=$(docker buildx imagetools inspect "$REPOSITORY@$INDEX_DIGEST" --format '{{json .Manifest}}')

platform_digest() {
  printf '%s' "$MANIFEST" | jq -r --arg os "${1%%/*}" --arg arch "${1#*/}" \
    '[.manifests[]? | select(.platform.os == $os and .platform.architecture == $arch)][0].digest // empty'
}

NAME=$(basename "$REPOSITORY")
for PLATFORM in $PLATFORMS; do
  DIGEST=$(platform_digest "$PLATFORM")
  if [ -z "$DIGEST" ]; then
    echo "$REPOSITORY@$INDEX_DIGEST has no $PLATFORM manifest." >&2
    exit 1
  fi
  echo "$PLATFORM is $DIGEST"

  # One SBOM per platform, attached to that platform's manifest: the files in
  # the arm64 image are not the files in the amd64 one.
  SBOM="$OUT_DIR/$NAME-$TAG-${PLATFORM%%/*}-${PLATFORM#*/}.cdx.json"
  "$HERE/sbom.sh" "registry:$REPOSITORY@$DIGEST" "$SBOM" "$PLATFORM"
  cosign_cmd attest --yes --type cyclonedx --predicate "$SBOM" "$REPOSITORY@$DIGEST"
done

# By digest: nothing is tagged yet, and a tag could move under cosign anyway.
# --recursive signs the index and every manifest in it, so a digest pulled for
# one platform verifies as well as the multi-platform tag does.
cosign_cmd sign --yes --recursive "$REPOSITORY@$INDEX_DIGEST"

# Verified as an operator will verify it, the index and each platform, so a
# signature or attestation the registry accepted but cannot serve back fails the
# release before any tag points at it.
cosign_cmd verify --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
  "$REPOSITORY@$INDEX_DIGEST" > /dev/null
for PLATFORM in $PLATFORMS; do
  DIGEST=$(platform_digest "$PLATFORM")
  cosign_cmd verify --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
    "$REPOSITORY@$DIGEST" > /dev/null
  cosign_cmd verify-attestation --type cyclonedx --certificate-identity "$IDENTITY" \
    --certificate-oidc-issuer "$ISSUER" "$REPOSITORY@$DIGEST" > /dev/null
done

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: digests resolved and SBOMs generated for $PLATFORMS; nothing was signed."
else
  echo "Signed and verified $REPOSITORY@$INDEX_DIGEST with an SBOM attested for: $PLATFORMS"
fi
