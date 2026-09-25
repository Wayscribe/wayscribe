#!/bin/sh
# Publishes the Python SDK (`wayscribe`) to PyPI or TestPyPI with trusted
# publishing and PEP 740 attestations. No PyPI token exists anywhere in the
# project: GitLab mints an OIDC token for the job (PYPI_ID_TOKEN, audience
# `pypi`, or TESTPYPI_ID_TOKEN, audience `testpypi`), twine exchanges it for an
# upload token that expires almost immediately, and SIGSTORE_ID_TOKEN signs the
# attestation PyPI shows beside each file (docs/OPERATIONS.md).
#
#   scripts/publish-python.sh packages/sdk-python/v0.1.0a1
#
# INDEX=testpypi uploads to TestPyPI instead of PyPI. DRY_RUN=1 builds and
# checks everything and uploads nothing; it needs no token and runs anywhere
# with Python 3.11 or newer (WAYSCRIBE_TEST_PYTHON picks the interpreter).
set -eu

# Exact versions: a release job must not change behavior because a tool did.
BUILD_TOOLS="twine==7.0.0 pypi-attestations==0.0.30"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

TAG=${1:-}
INDEX=${INDEX:-pypi}
python=${WAYSCRIBE_TEST_PYTHON:-python3}
root=$(cd "$(dirname "$0")/.." && pwd)
package=$root/packages/sdk-python
dist=$package/dist

VERSION=$("$python" -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["project"]["version"])' "$package/pyproject.toml")
[ "$TAG" = "packages/sdk-python/v$VERSION" ] ||
  fail "the tag must be packages/sdk-python/v$VERSION, the version in pyproject.toml; got '${TAG}'"
SOURCE_VERSION=$(PYTHONPATH="$package/src" "$python" -c 'import wayscribe._version as v; print(v.__version__)')
[ "$SOURCE_VERSION" = "$VERSION" ] ||
  fail "pyproject.toml says $VERSION but wayscribe/_version.py says $SOURCE_VERSION"

case "$INDEX" in
  pypi) ID_TOKEN=${PYPI_ID_TOKEN:-} ;;
  testpypi) ID_TOKEN=${TESTPYPI_ID_TOKEN:-} ;;
  *) fail "INDEX must be pypi or testpypi, not '$INDEX'" ;;
esac

WAYSCRIBE_TEST_PYTHON=$python sh "$package/scripts/build.sh"

# Exactly the two files a release consists of, and nothing else.
FILES=$(cd "$dist" && ls | LC_ALL=C sort | tr '\n' ' ')
EXPECTED="wayscribe-$VERSION-py3-none-any.whl wayscribe-$VERSION.tar.gz "
[ "$FILES" = "$EXPECTED" ] || fail "dist holds ${FILES}; expected ${EXPECTED}"

# The wheel installs the `wayscribe` package, its metadata and the licenses,
# and nothing else: no tests, no scripts, no second top-level package.
"$python" - "$dist/wayscribe-$VERSION-py3-none-any.whl" "$VERSION" <<'EOF'
import sys, zipfile
wheel, version = sys.argv[1], sys.argv[2]
meta = f"wayscribe-{version}.dist-info/"
names = zipfile.ZipFile(wheel).namelist()
stray = [n for n in names if not (n.startswith("wayscribe/") or n.startswith(meta))]
if stray:
    sys.exit(f"FAIL: the wheel holds files outside wayscribe/ and its metadata: {stray}")
for required in ("wayscribe/__init__.py", "wayscribe/py.typed", meta + "licenses/LICENSE", meta + "licenses/NOTICE"):
    if required not in names:
        sys.exit(f"FAIL: the wheel is missing {required}")
EOF

tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT
"$python" -m venv "$tools"
"$tools/bin/python" -m pip install --quiet --disable-pip-version-check $BUILD_TOOLS
"$tools/bin/twine" check --strict "$dist"/*

# twine attaches an attestation only when its file is among the arguments; it
# never looks beside a distribution for one. Upload the four files by name, and
# ask twine's own input splitter now whether each distribution has its
# attestation, so the dry run on main catches what the release job would.
WHEEL=$dist/wayscribe-$VERSION-py3-none-any.whl
SDIST=$dist/wayscribe-$VERSION.tar.gz
set -- "$WHEEL" "$SDIST" "$WHEEL.publish.attestation" "$SDIST.publish.attestation"
"$tools/bin/python" - "$@" <<'EOF'
import sys
from twine.commands import _split_inputs
uploads, _, attestations = _split_inputs(sys.argv[1:])
missing = [u for u in uploads if len(attestations.get(u, [])) != 1]
if len(uploads) != 2 or missing:
    sys.exit(f"FAIL: twine would upload {uploads} without an attestation for {missing}")
EOF

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY RUN: $TAG builds and checks; nothing uploaded to $INDEX."
  exit 0
fi

[ -n "$ID_TOKEN" ] || fail "no OIDC token for $INDEX; run this from the GitLab release job"
[ -n "${SIGSTORE_ID_TOKEN:-}" ] || fail "no SIGSTORE_ID_TOKEN; the attestations cannot be signed"

"$tools/bin/python" -m pypi_attestations sign "$WHEEL" "$SDIST"
for file in "$WHEEL" "$SDIST"; do
  [ -s "$file.publish.attestation" ] || fail "pypi_attestations wrote no attestation for $file"
done
TWINE_NON_INTERACTIVE=1 "$tools/bin/twine" upload --repository "$INDEX" --attestations "$@"
