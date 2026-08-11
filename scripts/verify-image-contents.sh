#!/bin/sh
# What is allowed to be inside the API runtime image.
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
# Usage: scripts/verify-image-contents.sh <image>
set -eu

IMAGE="${1:?usage: verify-image-contents.sh <image>}"
FAILED=0

report() {
  if [ "$2" -eq 0 ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1"
    FAILED=1
  fi
}

echo "Verifying contents of $IMAGE"

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

for DIR in /app/apps/demo /app/apps/web; do
  # `cmd; report $?` would abort here under `set -e` on the first failure, so a
  # broken image would report one problem and hide the rest. The `&&`/`||` form
  # keeps the non-zero status out of `set -e`'s hands.
  docker run --rm --entrypoint sh "$IMAGE" -c "test ! -e $DIR" && RC=0 || RC=1
  report "$DIR absent" "$RC"
done

# The prune has to stop short of the things the documentation tells an operator
# to run. OPERATIONS.md and deploy/helm/README.md both invoke the database CLI
# by path inside this image.
for FILE in /app/apps/api/dist/server.js /app/packages/database/dist/cli.js; do
  docker run --rm --entrypoint sh "$IMAGE" -c "test -f $FILE" && RC=0 || RC=1
  report "$FILE present" "$RC"
done

# Present is not the same as loadable: pruning a directory the CLI imports at
# runtime leaves the file in place and breaks it on first use. Invoking it with
# no arguments makes it resolve its imports and reach its own usage message.
OUTPUT=$(docker run --rm --entrypoint node "$IMAGE" packages/database/dist/cli.js 2>&1 || true)
case "$OUTPUT" in
  *DATABASE_URL* | *Usage* | *usage*) RC=0 ;;
  *) RC=1; echo "        unexpected CLI output: $OUTPUT" ;;
esac
report "database CLI runs" "$RC"

if [ "$FAILED" -ne 0 ]; then
  echo "Image contains files it should not, or is missing files it must have."
  exit 1
fi

echo "Image contents verified."
