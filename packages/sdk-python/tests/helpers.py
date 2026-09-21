import contextlib
import datetime as dt
import io
import json
import math
import threading
import unittest
from collections.abc import Mapping
from wayscribe._config import resolve_config
from wayscribe._diagnostics import Diagnostics
from wayscribe._event import build_envelope
from wayscribe._capture import capture, UNSET


class Hostile(Mapping):
    def __getitem__(self, key):
        raise RuntimeError("DO_NOT_LEAK")

    def __iter__(self):
        raise RuntimeError("DO_NOT_LEAK")

    def __len__(self):
        raise RuntimeError("DO_NOT_LEAK")


def setup(**options):
    reports = []
    diagnostics = Diagnostics(on_diagnostic=reports.append)
    with contextlib.redirect_stderr(io.StringIO()):
        config = resolve_config(
            dict(
                endpoint="https://localhost",
                api_key="private",
                service="worker",
                environment="dev",
                **options,
            ),
            diagnostics,
        )
    return (config, diagnostics, reports)


def event(config, diagnostics, **fields):
    return json.loads(
        build_envelope(
            config,
            diagnostics,
            journey_id="jrn_123",
            entity={"type": "order", "id": "42"},
            operation="received",
            name="receive",
            **fields,
        )
    )["event"]


def run_isolated(source, *, timeout=10):
    """Exercise real process-scoped state without sharing it with other tests."""
    import subprocess
    import sys
    import textwrap
    from pathlib import Path

    prefix = f"import sys\nsys.path.insert(0, {str(Path(__file__).parent)!r})\n"
    return subprocess.run(
        [sys.executable, "-c", prefix + textwrap.dedent(source)],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
