#!/bin/sh
# Builds the SDK's wheel and sdist into packages/sdk-python/dist, replacing
# whatever was there. The mixed-language integration test installs that wheel,
# so CI runs this before `pnpm test:integration`: a wheel left over from an
# earlier local build once hid that nothing in CI produced one.
#
# Uses a throwaway venv with PyPA `build`, not uv, so the same command works in
# the node:24 CI image. WAYSCRIBE_TEST_PYTHON picks the interpreter, as it does
# for test.sh; otherwise python3.
set -eu

python=${WAYSCRIBE_TEST_PYTHON:-python3}
here=$(cd "$(dirname "$0")/.." && pwd)
venv=$(mktemp -d)
trap 'rm -rf "$venv"' EXIT

"$python" -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check build
rm -rf "$here/dist"
"$venv/bin/python" -m build --outdir "$here/dist" "$here"
