#!/bin/sh
# The two decisions publish-image.sh makes before it tags a release.
#
#   image-tag-policy.sh free <repository> <tag>
#       Exit 1, with a message, when <repository>:<tag> already exists in the
#       registry. A published version is immutable: a re-run of a tag pipeline
#       must not rebuild it and move what operators already pulled and verified.
#
#   image-tag-policy.sh moves-latest <tag>
#       Exit 0 when :latest should point at <tag>: it is a final version
#       (vX.Y.Z, no pre-release suffix) and the highest one. Exit 1 otherwise.
#       The tags come from RELEASE_TAGS (one per line) when set, else from
#       `git tag`, which needs the tags fetched (the publish job sets GIT_DEPTH: 0).
#
# The registry is asked with `docker buildx imagetools inspect`, the tool
# publish-image.sh already tags and verifies with. A failing inspect means the
# reference is absent.
set -eu

FINAL='^v[0-9]+\.[0-9]+\.[0-9]+$'

case "${1:-}" in
  free)
    REPOSITORY="${2:?usage: image-tag-policy.sh free <repository> <tag>}"
    TAG="${3:?usage: image-tag-policy.sh free <repository> <tag>}"
    if docker buildx imagetools inspect "$REPOSITORY:$TAG" >/dev/null 2>&1; then
      echo "image-tag-policy.sh: $REPOSITORY:$TAG already exists in the registry; a published version is never rebuilt or moved" >&2
      exit 1
    fi
    ;;
  moves-latest)
    TAG="${2:?usage: image-tag-policy.sh moves-latest <tag>}"
    if ! echo "$TAG" | grep -Eq "$FINAL"; then
      exit 1
    fi
    TAGS="${RELEASE_TAGS:-$(git tag --list 'v[0-9]*')}"
    HIGHEST=$(echo "$TAGS" | grep -E "$FINAL" | sort -V | tail -n 1)
    [ "$HIGHEST" = "$TAG" ]
    ;;
  *)
    echo "usage: image-tag-policy.sh free <repository> <tag> | moves-latest <tag>" >&2
    exit 2
    ;;
esac
