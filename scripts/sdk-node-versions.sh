#!/bin/sh
# The SDK on one Node version: build, unit tests, and a consumer check.
#
# packages/sdk-node declares `engines.node >=22.12.0`, and the README says
# `import` and `require()` both work there. The repository itself runs on Node
# 24, so nothing exercised that claim. This script does, for one version:
#
#   1. packs the release tarball with the repository's own Node, as
#      publish-sdk does, so the check below runs against the artifact that ships;
#   2. switches to the requested Node and builds the SDK with it;
#   3. runs the SDK's and the CLI's unit tests on it;
#   4. installs the tarball with that Node's npm into two throwaway projects,
#      one ESM and one CommonJS, and runs a script in each that creates a
#      recorder pointed at a port nothing listens on and calls a wrapper.
#
# The requested Node is downloaded from nodejs.org and checked against its
# published SHA-256 unless the running Node already has that version. It cannot
# simply be the job's image: pnpm 11 needs Node 22.13, so on 22.12 the
# dependencies could not be installed at all. They are installed first, with
# the repository's Node, and only the SDK runs on the older one.
#
# Usage: scripts/sdk-node-versions.sh <version>   e.g. 22.12.0, or 24
#        (after `pnpm install`; needs curl, tar, and sha256sum or shasum)
set -eu

WANT=${1:?usage: scripts/sdk-node-versions.sh <node version>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sdk-node-versions.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"

# 1. The release tarball, packed with the repository's Node and pnpm.
TARBALL=$(pnpm --silent --filter @flight-recorder/node run pack:release "$WORK")
TARBALL=$(printf '%s\n' "$TARBALL" | tail -n 1)
[ -f "$TARBALL" ] || { echo "FAIL: pack:release did not write a tarball ($TARBALL)" >&2; exit 1; }

# 2. The requested Node.
CURRENT=$(node -p process.versions.node)
case "$CURRENT" in
  "$WANT" | "$WANT".*)
    echo "Using the running Node, $CURRENT."
    ;;
  *)
    case "$(uname -s)" in
      Linux) OS=linux ;;
      Darwin) OS=darwin ;;
      *) echo "FAIL: no Node download for $(uname -s)" >&2; exit 1 ;;
    esac
    ARCH=$(node -p process.arch)
    NAME="node-v$WANT-$OS-$ARCH"
    BASE="https://nodejs.org/dist/v$WANT"
    curl -fsSL "$BASE/$NAME.tar.gz" -o "$WORK/$NAME.tar.gz"
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
    grep " $NAME.tar.gz\$" "$WORK/SHASUMS256.txt" > "$WORK/expected.txt"
    if command -v sha256sum > /dev/null 2>&1; then
      (cd "$WORK" && sha256sum -c expected.txt)
    else
      (cd "$WORK" && shasum -a 256 -c expected.txt)
    fi
    tar -xzf "$WORK/$NAME.tar.gz" -C "$WORK"
    # From here on `node`, `npm` and `npx` are the requested version, including
    # for the processes the build and Vitest start.
    PATH="$WORK/$NAME/bin:$PATH"
    export PATH
    ;;
esac
echo "Node $(node --version), npm $(npm --version)"

# 3. Build and unit tests on it. Vitest and the build tools are started with
# `node` directly: pnpm itself does not run on every supported Node.
(cd packages/sdk-node && node scripts/bundle.mjs)
node node_modules/vitest/vitest.mjs run --project node packages/sdk-node packages/cli

# 4. The consumer check. Port 9 is the discard port; nothing listens on it in a
# job container, so every delivery fails, which the SDK must absorb.
check() {
  kind=$1
  file=$2
  dir="$WORK/consumer-$kind"
  mkdir -p "$dir"
  printf '{ "name": "consumer-%s", "private": true, "type": "%s" }\n' "$kind" "$kind" > "$dir/package.json"
  cat > "$dir/$file"
  (cd "$dir" && npm install --no-audit --no-fund --silent "$TARBALL")
  (cd "$dir" && node "$file")
}

check module check.mjs <<'EOF'
import { createRecorder } from "@flight-recorder/node";

const recorder = createRecorder({
  endpoint: "http://127.0.0.1:9",
  apiKey: "fr_consumer_check",
  serviceName: "consumer-check",
  environment: "test",
  logDiagnostics: false
});
const journey = recorder.startJourney({ entity: { type: "customer", id: "c-1" } });
const input = { n: 2 };
const result = await journey.transform("double", input, () => ({ n: input.n * 2 }));
if (result.n !== 4) throw new Error(`transform returned ${JSON.stringify(result)}`);
await recorder.shutdown({ timeoutMs: 2000 });
console.log(`import: ok on Node ${process.version}`);
EOF

check commonjs check.cjs <<'EOF'
const { createRecorder } = require("@flight-recorder/node");

async function main() {
  const recorder = createRecorder({
    endpoint: "http://127.0.0.1:9",
    apiKey: "fr_consumer_check",
    serviceName: "consumer-check",
    environment: "test",
    logDiagnostics: false
  });
  const journey = recorder.startJourney({ entity: { type: "customer", id: "c-1" } });
  const input = { n: 2 };
  const result = await journey.transform("double", input, () => ({ n: input.n * 2 }));
  if (result.n !== 4) throw new Error(`transform returned ${JSON.stringify(result)}`);
  await recorder.shutdown({ timeoutMs: 2000 });
  console.log(`require: ok on Node ${process.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

echo "PASS: the SDK builds, tests, imports and requires on Node $(node --version)"
