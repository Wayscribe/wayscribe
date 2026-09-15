#!/bin/sh
# Attach an SBOM to each platform of a pushed image, and sign it, keylessly.
#
# Run by `publish-images` after each push. Signing uses GitLab's OIDC token
# (`id_tokens: SIGSTORE_ID_TOKEN` with `aud: sigstore`), which cosign reads from
# the environment, so there is no signing key to hold or leak. The certificate
# Fulcio issues names this project's pipeline and the tag it ran for, and that is
# what an operator verifies against (docs/OPERATIONS.md §11).
#
# Usage: scripts/attest-and-sign.sh <repository> <tag>
#   e.g. scripts/attest-and-sign.sh registry.gitlab.com/jojithedev/flight-recorder/api v1.0.0
#
# DRY_RUN=1 resolves the digests and generates every SBOM, then prints the
# cosign commands instead of running them. Signing cannot be rehearsed for real
# without publishing: a signature is pushed to the registry beside the image and
# recorded in the public transparency log. The dry run exercises everything up to
# that point, against any multi-platform image.
#
# Requires docker (with buildx), jq, and, unless DRY_RUN=1, SIGSTORE_ID_TOKEN and
# a `docker login` to the registry.
set -eu

REPOSITORY="${1:?usage: attest-and-sign.sh <repository> <tag>}"
TAG="${2:?usage: attest-and-sign.sh <repository> <tag>}"
DRY_RUN="${DRY_RUN:-0}"
PLATFORMS="${PLATFORMS:-linux/amd64 linux/arm64}"
OUT_DIR="${SBOM_DIR:-sboms}"

# Update the version and digest together:
# `docker buildx imagetools inspect ghcr.io/sigstore/cosign/cosign:<version>`.
COSIGN_IMAGE="${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8}"

# The identity an operator will verify with. On GitLab.com the certificate's
# subject is the pipeline definition at the ref it ran for; the double slash
# before .gitlab-ci.yml is part of the format.
ISSUER="${CI_SERVER_URL:-https://gitlab.com}"
IDENTITY="${ISSUER}/${CI_PROJECT_PATH:-jojithedev/flight-recorder}//.gitlab-ci.yml@refs/tags/${TAG}"

HERE=$(dirname "$0")

cosign_cmd() {
  if [ "$DRY_RUN" = "1" ]; then
    # stderr, so a caller redirecting the real output does not hide the plan.
    echo "  dry run: cosign $*" >&2
    return 0
  fi
  cosign "$@"
}

if [ "$DRY_RUN" != "1" ]; then
  if [ -z "${SIGSTORE_ID_TOKEN:-}" ]; then
    echo "SIGSTORE_ID_TOKEN is not set. The job needs id_tokens: SIGSTORE_ID_TOKEN with aud: sigstore." >&2
    exit 1
  fi
  # The static binary, copied out of the pinned image rather than run as a
  # container: cosign has to read the SBOM file and this job's registry login,
  # and under docker-in-docker a container sees neither.
  if ! command -v cosign > /dev/null 2>&1; then
    CONTAINER=$(docker create "$COSIGN_IMAGE")
    docker cp "$CONTAINER:/ko-app/cosign" /usr/local/bin/cosign
    docker rm "$CONTAINER" > /dev/null
  fi
  cosign version | grep GitVersion
fi

MANIFEST=$(docker buildx imagetools inspect "$REPOSITORY:$TAG" --format '{{json .Manifest}}')
INDEX_DIGEST=$(printf '%s' "$MANIFEST" | jq -r '.digest')
echo "$REPOSITORY:$TAG is $INDEX_DIGEST"

NAME=$(basename "$REPOSITORY")
for PLATFORM in $PLATFORMS; do
  OS=${PLATFORM%%/*}
  ARCH=${PLATFORM#*/}
  DIGEST=$(printf '%s' "$MANIFEST" | jq -r --arg os "$OS" --arg arch "$ARCH" \
    '[.manifests[]? | select(.platform.os == $os and .platform.architecture == $arch)][0].digest // empty')
  if [ -z "$DIGEST" ]; then
    echo "$REPOSITORY:$TAG has no $PLATFORM manifest." >&2
    exit 1
  fi
  echo "$PLATFORM is $DIGEST"

  # One SBOM per platform, attached to that platform's manifest: the files in
  # the arm64 image are not the files in the amd64 one.
  SBOM="$OUT_DIR/$NAME-$TAG-$OS-$ARCH.cdx.json"
  "$HERE/sbom.sh" "registry:$REPOSITORY@$DIGEST" "$SBOM" "$PLATFORM"
  cosign_cmd attest --yes --type cyclonedx --predicate "$SBOM" "$REPOSITORY@$DIGEST"
done

# By digest, never by tag: a tag is resolved when cosign reads it, and can move.
# --recursive signs the index and every manifest in it, so a digest pulled for
# one platform verifies as well as the multi-platform tag does.
cosign_cmd sign --yes --recursive "$REPOSITORY@$INDEX_DIGEST"

# Verified as an operator will verify it, so a signature or attestation that the
# registry accepted but cannot serve back fails the release rather than a user.
cosign_cmd verify --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
  "$REPOSITORY:$TAG" > /dev/null
for PLATFORM in $PLATFORMS; do
  OS=${PLATFORM%%/*}
  ARCH=${PLATFORM#*/}
  DIGEST=$(printf '%s' "$MANIFEST" | jq -r --arg os "$OS" --arg arch "$ARCH" \
    '[.manifests[]? | select(.platform.os == $os and .platform.architecture == $arch)][0].digest')
  cosign_cmd verify-attestation --type cyclonedx --certificate-identity "$IDENTITY" \
    --certificate-oidc-issuer "$ISSUER" "$REPOSITORY@$DIGEST" > /dev/null
done

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run complete: digests resolved and SBOMs generated; nothing was signed or pushed."
else
  echo "Signed $REPOSITORY@$INDEX_DIGEST and attested an SBOM for: $PLATFORMS"
fi
