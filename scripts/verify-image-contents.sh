#!/bin/sh
# What is allowed to be inside a runtime image, and what must be there.
#
# The image once carried 61 test files, 167 TypeScript sources, the demo
# application and the web application, because the Dockerfile copied the whole
# build tree forward. None of it was reachable — the entrypoint runs `dist` —
# but test fixtures include credential-shaped strings, and a scanner reading a
# published image cannot tell a fixture from a leak.
#
# This runs against the built image rather than reading the Dockerfile, because
# the question is what shipped, not what the build intended to ship.
#
# Usage: scripts/verify-image-contents.sh <image> [api|web]
#
# The kind defaults to api, which runs every check below. web runs only the
# checks that apply to the web image: the legal files and its entry point. The
# rest are written against the API image's layout, a whole workspace tree under
# /app, which the web image, a Next standalone bundle, does not have.
set -eu

IMAGE="${1:?usage: verify-image-contents.sh <image> [api|web]}"
KIND="${2:-api}"
case "$KIND" in
  api | web) ;;
  *)
    echo "usage: verify-image-contents.sh <image> [api|web]" >&2
    exit 2
    ;;
esac
FAILED=0

report() {
  if [ "$2" -eq 0 ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1"
    FAILED=1
  fi
}

echo "Verifying contents of $IMAGE ($KIND)"

# Apache-2.0 asks a redistributor to pass on the LICENSE and NOTICE, and every
# published image is a redistribution. Both Dockerfiles copy them to /licenses.
# Checked non-empty rather than merely present, since an empty file satisfies
# `test -e` and informs nobody.
for FILE in /licenses/LICENSE /licenses/NOTICE; do
  docker run --rm --entrypoint sh "$IMAGE" -c "test -s $FILE" && RC=0 || RC=1
  report "$FILE present" "$RC"
done

if [ "$KIND" = "web" ]; then
  docker run --rm --entrypoint sh "$IMAGE" -c "test -f /app/apps/web/server.js" && RC=0 || RC=1
  report "/app/apps/web/server.js present" "$RC"
  if [ "$FAILED" -ne 0 ]; then
    echo "Image is missing files it must have."
    exit 1
  fi
  echo "Image contents verified."
  exit 0
fi

# Nothing under node_modules is our doing — a dependency shipping its own tests
# is that dependency's decision, and pruning it is a job for the package manager.
count_in_image() {
  # `wc -l` pads its output on some shells, so the result is stripped rather
  # than compared as a string.
  docker run --rm --entrypoint sh "$IMAGE" -c "$1" | tr -d '[:space:]'
}

COUNT=$(count_in_image 'find /app -path /app/node_modules -prune -o -type f \( -name "*.test.*" -o -name "*.spec.*" \) -print | wc -l')
report "no test files (found $COUNT)" "$([ "$COUNT" -eq 0 ] && echo 0 || echo 1)"

COUNT=$(count_in_image 'find /app -path /app/node_modules -prune -o -type d -name src -print | wc -l')
report "no source directories (found $COUNT)" "$([ "$COUNT" -eq 0 ] && echo 0 || echo 1)"

# The conformance fixtures are the reason this check gained a third directory.
# They are not named like test files, so the pattern above does not reach them,
# and they carry credential-shaped values on purpose: a redaction case cannot
# prove a secret was replaced without holding something shaped like one.
for DIR in /app/apps/demo /app/apps/web /app/packages/protocol/conformance /app/packages/sdk-node; do
  # `cmd; report $?` would abort here under `set -e` on the first failure, so a
  # broken image would report one problem and hide the rest. The `&&`/`||` form
  # keeps the non-zero status out of `set -e`'s hands.
  docker run --rm --entrypoint sh "$IMAGE" -c "test ! -e $DIR" && RC=0 || RC=1
  report "$DIR absent" "$RC"
done

# Absent as a directory is not the same as absent as content. The fixtures'
# fake credentials all carry one marker, so searching for it catches a copy that
# landed somewhere else, which is the failure a directory check cannot see.
#
# `find` and `xargs` rather than `grep -r --exclude-dir`: the image is Alpine,
# whose busybox grep has no such option. The first version of this check used
# it, printed a usage message to stderr that `2>/dev/null` swallowed, counted
# zero and passed — against an image that held eleven of these files. It was
# caught by running it against an image built without the prune, which is what
# ADR-043 asks for and the reason that step is not optional.
#
# The marker is assembled from two halves so that this script is not itself a
# match, and .gitleaks.toml is excluded because the allowlist has to name the
# marker in order to allow it. Neither is a fixture and neither holds a value.
MARKER='cfx''-fake'
COUNT=$(count_in_image "find /app -path /app/node_modules -prune -o -type f ! -name .gitleaks.toml -print0 | xargs -0 -r grep -l '$MARKER' 2>/dev/null | wc -l")
report "no conformance fixture values (found $COUNT files)" "$([ "$COUNT" -eq 0 ] && echo 0 || echo 1)"

# The prune has to stop short of the things the documentation tells an operator
# to run. OPERATIONS.md and deploy/helm/README.md both invoke the database CLI
# by path inside this image.
for FILE in /app/apps/api/dist/server.js /app/packages/database/dist/cli.js; do
  docker run --rm --entrypoint sh "$IMAGE" -c "test -f $FILE" && RC=0 || RC=1
  report "$FILE present" "$RC"
done

# Present is not the same as loadable: pruning a directory an entry point
# imports leaves the file in place and breaks it on first use.
#
# The check that used to live here ran the CLI with no arguments and accepted
# any output mentioning DATABASE_URL. The CLI exits on that guard at the top of
# the file, and every subcommand is behind a dynamic import, so nothing past the
# guard was ever resolved: deleting payload-diff/dist and payload-security/dist
# left this green while the server could not start. It proved the file existed,
# which the check above already did.
#
# So both entry points are made to resolve their whole graph, and the failure
# looked for is `ERR_MODULE_NOT_FOUND` specifically. In ESM the module graph is
# evaluated before the entry module's body runs, so a missing workspace `dist`
# surfaces ahead of any configuration guard, and the two are told apart by what
# is printed rather than by an exit code they share.
loads() {
  NAME="$1"
  OUTPUT=$(docker run --rm --entrypoint sh "$IMAGE" -c "$2" 2>&1 || true)
  case "$OUTPUT" in
    *ERR_MODULE_NOT_FOUND* | *"Cannot find module"* | *"Cannot find package"*)
      report "$NAME resolves its imports" 1
      echo "        $(echo "$OUTPUT" | grep -m1 'Cannot find')"
      return
      ;;
  esac
  case "$OUTPUT" in
    *$3*) report "$NAME resolves its imports" 0 ;;
    *)
      report "$NAME resolves its imports" 1
      echo "        unexpected output: $(echo "$OUTPUT" | head -3)"
      ;;
  esac
}

# The server statically imports config, database, protocol, payload-security and
# payload-diff, so reaching its own configuration error means all five resolved.
loads "the API server" "node apps/api/dist/server.js" "DATABASE_URL"

# A subcommand, because that is what forces the CLI's dynamic imports. A
# database that is not there makes it fail at the connection, which is after the
# import it exists to check.
loads "the database CLI" \
  "DATABASE_URL=postgresql://u:p@127.0.0.1:1/x node packages/database/dist/cli.js project:list" \
  "ECONNREFUSED"

if [ "$FAILED" -ne 0 ]; then
  echo "Image contains files it should not, or is missing files it must have."
  exit 1
fi

echo "Image contents verified."
