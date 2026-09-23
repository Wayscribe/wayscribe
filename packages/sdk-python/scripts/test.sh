#!/bin/sh
# Runs the Python SDK's unittest suite on Python 3.11 or newer, the SDK's
# floor, never on whatever `python3` happens to be. WAYSCRIBE_TEST_PYTHON picks
# the interpreter, as it does for the integration tests; otherwise the first
# of python3.11 .. python3.14, then python3, that is new enough.
set -eu

new_enough() {
  "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null
}

if [ -n "${WAYSCRIBE_TEST_PYTHON:-}" ]; then
  python=$WAYSCRIBE_TEST_PYTHON
  if ! command -v "$python" >/dev/null 2>&1; then
    echo "test:python: WAYSCRIBE_TEST_PYTHON=$python was not found." >&2
    exit 1
  fi
  if ! new_enough "$python"; then
    echo "test:python: WAYSCRIBE_TEST_PYTHON=$python is $("$python" -V 2>&1); the SDK needs Python 3.11 or newer." >&2
    exit 1
  fi
else
  python=
  for candidate in python3.11 python3.12 python3.13 python3.14 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && new_enough "$candidate"; then
      python=$candidate
      break
    fi
  done
  if [ -z "$python" ]; then
    echo "test:python: no Python 3.11 or newer found (tried python3.11 to python3.14 and python3). Install one, or set WAYSCRIBE_TEST_PYTHON." >&2
    exit 1
  fi
fi

here=$(cd "$(dirname "$0")/.." && pwd)
echo "test:python: $("$python" -V 2>&1) ($(command -v "$python"))" >&2
PYTHONPATH="$here/src" exec "$python" -m unittest "$@"
