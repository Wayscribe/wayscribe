#!/bin/sh
# A CycloneDX software bill of materials for one image, with Syft.
#
# One command for both places an SBOM is made: the `sbom` job, which builds the
# images on the default branch and keeps the SBOMs as artifacts, and
# scripts/attest-and-sign.sh, which attaches them to a published release. The
# release path is therefore the path every default-branch pipeline runs, rather
# than YAML that only executes on the day of a release.
#
# Usage: scripts/sbom.sh <source> <output-file> [platform]
#
#   source    Syft's source syntax: docker:<image> for an image in the Docker
#             daemon, registry:<repository>@sha256:<digest> for a pushed one.
#   platform  linux/amd64 or linux/arm64, for a multi-platform registry source.
#
# Syft runs as a container, pinned by version and digest, and writes the SBOM
# to stdout. Not to a bind-mounted directory: under docker-in-docker a bind
# mount names the dind service's filesystem, not the job's, so the file would
# be written somewhere the job cannot see. The Docker socket mount is the
# daemon's own socket, which is why it does work there.
#
# Requires docker and jq.
set -eu

SOURCE="${1:?usage: sbom.sh <source> <output-file> [platform]}"
OUTPUT="${2:?usage: sbom.sh <source> <output-file> [platform]}"
PLATFORM="${3:-}"

# Changing this changes what every SBOM contains. Update the version and the
# digest together: `docker buildx imagetools inspect anchore/syft:<version>`.
SYFT_IMAGE="${SYFT_IMAGE:-anchore/syft:v1.51.1@sha256:95fe0835e5bebc6f8b1f8acef68d47d63d594ef4c0f25c097ff853b23cbac74c}"

set -- run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SYFT_CHECK_FOR_APP_UPDATE=false

# Registry credentials for a private registry source, passed by name so the
# password never appears in a process listing.
if [ -n "${CI_REGISTRY_PASSWORD:-}" ]; then
  export SYFT_REGISTRY_AUTH_AUTHORITY="$CI_REGISTRY"
  export SYFT_REGISTRY_AUTH_USERNAME="$CI_REGISTRY_USER"
  export SYFT_REGISTRY_AUTH_PASSWORD="$CI_REGISTRY_PASSWORD"
  set -- "$@" -e SYFT_REGISTRY_AUTH_AUTHORITY -e SYFT_REGISTRY_AUTH_USERNAME -e SYFT_REGISTRY_AUTH_PASSWORD
fi

set -- "$@" "$SYFT_IMAGE" scan "$SOURCE" --output cyclonedx-json@1.6 --quiet
if [ -n "$PLATFORM" ]; then
  set -- "$@" --platform "$PLATFORM"
fi

mkdir -p "$(dirname "$OUTPUT")"
docker "$@" > "$OUTPUT"

# An empty or truncated document must fail here, not at an operator's scanner.
FORMAT=$(jq -r '.bomFormat // empty' "$OUTPUT")
COMPONENTS=$(jq '.components | length' "$OUTPUT")
if [ "$FORMAT" != "CycloneDX" ] || [ "$COMPONENTS" -eq 0 ]; then
  echo "sbom.sh: $OUTPUT is not a CycloneDX SBOM with components (format '$FORMAT', $COMPONENTS components)" >&2
  exit 1
fi

SUBJECT=$(jq -r '.metadata.component | "\(.name) \(.version // "")"' "$OUTPUT")
SPEC=$(jq -r '.specVersion' "$OUTPUT")
BYTES=$(wc -c < "$OUTPUT" | tr -d '[:space:]')
echo "SBOM $OUTPUT: CycloneDX $SPEC, $COMPONENTS components, $BYTES bytes, subject $SUBJECT${PLATFORM:+, $PLATFORM}"
