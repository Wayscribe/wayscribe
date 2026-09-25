#!/bin/sh
# Publish @wayscribe/node to npm with trusted publishing and provenance.
#
# Usage: scripts/publish-sdk.sh <tag>        e.g. scripts/publish-sdk.sh v0.1.0
#        DRY_RUN=1 scripts/publish-sdk.sh <tag>
#
# There is no npm credential anywhere. GitLab mints NPM_ID_TOKEN for the
# publish-sdk job alone, with the audience npm:registry.npmjs.org, and npm
# exchanges it for a publish token that expires almost immediately. npm stopped
# issuing classic and Automation tokens in November 2025 and revoked the rest
# that December; the granular tokens left expire in 90 days at most, which for a
# project that releases every few weeks is a secret expired more often than not.
# SIGSTORE_ID_TOKEN signs the provenance statement npm attaches, which names the
# pipeline, the commit and this CI file.
#
# npm only accepts the exchange from a package whose trusted publisher is
# registered on npmjs.com, once, before the first release. docs/OPERATIONS.md
# §11 has the exact values.
#
# The package is packed by packages/sdk-node/scripts/pack.mjs and the tarball
# published by npm. Only pnpm applies `publishConfig.exports` and rewrites
# `workspace:` ranges, so the script packs with pnpm, strips the manifest of
# build-only fields and repacks; only npm performs the OIDC exchange.
#
# A script rather than YAML because release logic written inline in CI is never
# run before the release it is needed for. DRY_RUN=1 runs everything except the
# publish itself, and needs neither token. It forces npm's publish preflight so
# an already-public version can still rehearse; --dry-run prevents the write.
set -eu

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: [DRY_RUN=1] $0 <tag>   e.g. $0 v0.1.0" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
PACKAGE_DIR=packages/sdk-node

VERSION="$(node -p "require('./${PACKAGE_DIR}/package.json').version")"
if [ "v${VERSION}" != "$TAG" ]; then
  echo "FAIL: ${PACKAGE_DIR}/package.json is version ${VERSION}, so the tag must be v${VERSION}, not ${TAG}." >&2
  exit 1
fi

# Fail on the version, not inside publish. npm below 11.5.1 ignores NPM_ID_TOKEN
# and then fails as if nobody had logged in, which sends you looking at
# credentials that were never the problem.
NPM_VERSION="$(npm --version)"
if ! node -e '
  const [a, b, c] = process.argv[1].split(".").map(Number);
  process.exit(a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1))) ? 0 : 1);
' "$NPM_VERSION"; then
  echo "FAIL: trusted publishing needs npm 11.5.1 or later, found ${NPM_VERSION}." >&2
  exit 1
fi

if [ "${DRY_RUN:-}" != "1" ]; then
  if [ -z "${NPM_ID_TOKEN:-}" ]; then
    echo "FAIL: NPM_ID_TOKEN is not set, so trusted publishing is not in effect." >&2
    echo "The job must declare id_tokens: NPM_ID_TOKEN with aud npm:registry.npmjs.org." >&2
    echo "A long-lived NPM_TOKEN is deliberately not accepted." >&2
    exit 1
  fi
  if [ -z "${SIGSTORE_ID_TOKEN:-}" ]; then
    echo "FAIL: SIGSTORE_ID_TOKEN is not set, so npm cannot sign provenance." >&2
    echo "The job must declare id_tokens: SIGSTORE_ID_TOKEN with aud sigstore." >&2
    exit 1
  fi
  # An explicitly empty token in a config file is worse than none: npm reads it
  # and stops looking for the OIDC token.
  unset NPM_TOKEN NODE_AUTH_TOKEN 2> /dev/null || true
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
node "${PACKAGE_DIR}/scripts/pack.mjs" "$OUT" > /dev/null
set -- "$OUT"/*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "FAIL: expected one tarball in ${OUT}, found: $*" >&2
  exit 1
fi
TARBALL="$1"

# The manifest a user installs, checked rather than trusted: a published
# `development` condition would point at src/, which is not in the tarball, a
# `workspace:` range cannot be installed from the registry, and build-only
# fields are noise in every user's node_modules.
#
# And the files: the bundle, one declaration file, the README, and the LICENSE
# and NOTICE that Apache-2.0 asks a redistributor to pass on, and nothing else.
# Thirteen internal declaration files and their maps once shipped, importable
# under legacy module resolution and failing at runtime.
FILES="$(tar -tzf "$TARBALL" | LC_ALL=C sort | tr '\n' ' ')"
EXPECTED="package/LICENSE package/NOTICE package/README.md package/dist/index.d.ts package/dist/index.js package/package.json "
if [ "$FILES" != "$EXPECTED" ]; then
  echo "FAIL: the tarball holds ${FILES}; expected ${EXPECTED}" >&2
  exit 1
fi

# Present is not enough: the legal files are the repository root's, byte for
# byte, since pack.mjs copies them from there and nowhere else keeps a copy.
for NAME in LICENSE NOTICE; do
  if ! tar -xzOf "$TARBALL" "package/${NAME}" | cmp -s - "$NAME"; then
    echo "FAIL: package/${NAME} in the tarball differs from ${NAME} at the repository root." >&2
    exit 1
  fi
done

tar -xzOf "$TARBALL" package/package.json | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => {
    const manifest = JSON.parse(text);
    const problems = [];
    if (text.includes("workspace:")) problems.push("a workspace: range");
    if (JSON.stringify(manifest.exports ?? {}).includes("development")) {
      problems.push("a development export condition");
    }
    if (manifest.devDependencies !== undefined) problems.push("devDependencies");
    if (manifest.scripts !== undefined) problems.push("scripts");
    if (!/gitlab\.com\/jojithedev\/wayscribe/.test(manifest.repository?.url ?? "")) {
      problems.push("a repository.url npm cannot match to this project for provenance");
    }
    if (problems.length > 0) {
      console.error(`FAIL: the packed manifest has ${problems.join(", ")}.`);
      process.exit(1);
    }
  });
'

if [ "${DRY_RUN:-}" = "1" ]; then
  npm publish "$TARBALL" --access public --dry-run --force
  echo "dry run passed for @wayscribe/node@${VERSION}; nothing was published"
  exit 0
fi

npm publish "$TARBALL" --access public --provenance
echo "published @wayscribe/node@${VERSION} with provenance"
