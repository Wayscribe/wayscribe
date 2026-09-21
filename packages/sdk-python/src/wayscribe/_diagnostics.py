"""Safe reports and independent, internally synchronized accounting.

Never call emit while holding the recorder/transport lock: callbacks may reenter
that recorder. Counter methods never invoke user code. Diagnostics never takes a
recorder lock, so transport may increment counters under its own lock.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

DROP_CAUSES = ("queue_full", "after_shutdown", "shutdown", "retry_budget", "no_verdict")
_process_lock = threading.Lock()
_process_warnings: set[tuple[str, ...]] = set()


def _reset_process_warnings_after_fork() -> None:
    # A vanished parent thread may own the inherited lock. Fresh recorders in
    # the child must use fresh process-local suppression state without touching
    # it. Inherited recorder/Diagnostics instances still need facade PID guards.
    global _process_lock, _process_warnings
    _process_lock = threading.Lock()
    _process_warnings = set()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_process_warnings_after_fork)


def _claim_process_warning(kind: str, report: dict[str, Any]) -> bool | None:
    """Claim a bounded kind-specific warning identity, never invoking host code."""
    if kind == "unredacted_secret_name":
        from ._capture import fold

        token = (kind, fold(report.get("name", "")))
    elif kind == "personal_data":
        token = (kind, report.get("field", ""), report.get("shape", ""))
    elif kind == "configuration_error":
        token = (kind, report.get("setting", ""))
    elif kind == "derivation_fallback":
        token = (kind,)
    else:
        return None
    with _process_lock:
        if token in _process_warnings or len(_process_warnings) >= 2000:
            return False
        _process_warnings.add(token)
        return True


class Diagnostics:
    def __init__(
        self,
        *,
        on_diagnostic: Callable[[dict[str, Any]], Any] | None = None,
        log_diagnostics: bool = False,
    ) -> None:
        self._lock = threading.Lock()
        self._callback = on_diagnostic if callable(on_diagnostic) else None
        self._logging = log_diagnostics is True
        self._counts = dict.fromkeys(
            (
                "recorded",
                "sent",
                "rejected",
                "dropped",
                "payloads_omitted",
                "payloads_truncated",
                "configuration_errors",
                "capture_errors",
                "unredacted_secret_names",
            ),
            0,
        )
        self._drops = dict.fromkeys(DROP_CAUSES, 0)
        self._settings = set()
        self._names = set()
        self._last_log = {}

    def configure(
        self,
        *,
        on_diagnostic: Callable[[dict[str, Any]], Any] | None = None,
        log_diagnostics: bool = False,
    ) -> None:
        with self._lock:
            self._callback = on_diagnostic if callable(on_diagnostic) else None
            self._logging = log_diagnostics is True

    def increment(
        self, counter: str, amount: int = 1, *, cause: str | None = None
    ) -> None:
        if type(amount) is not int or amount < 0:
            return
        with self._lock:
            if counter not in self._counts:
                return
            if counter == "dropped":
                if cause not in self._drops:
                    return
                self._drops[cause] += amount
            self._counts[counter] += amount

    def counters(self) -> dict[str, Any]:
        with self._lock:
            return {**self._counts, "dropped_by_cause": dict(self._drops)}

    def rejected_settings(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(sorted(self._settings))

    def reject_setting(self, setting: str) -> None:
        with self._lock:
            self._settings.add(setting)
        self.increment("configuration_errors")
        self.emit("configuration_error", setting=setting, creation=True)

    def report_name(self, field: str, name: str, path: str) -> None:
        from ._capture import fold

        folded = fold(name)
        with self._lock:
            if folded in self._names or len(self._names) >= 1000:
                return
            self._names.add(folded)
        self.increment("unredacted_secret_names")
        self.emit(
            "unredacted_secret_name",
            field=field,
            code="add_redaction_or_known_safe_name",
            name=name[:128],
            path=path[:512],
        )

    def emit(self, kind: str, **safe_fields: Any) -> None:
        try:
            allowed = {
                "configuration_error",
                "capture_error",
                "payload_omitted",
                "payload_truncated",
                "invalid_event",
                "invalid_option",
                "insecure_endpoint",
                "personal_data",
                "unredacted_secret_name",
                "derivation_fallback",
                "dropped",
                "sent",
                "rejected",
                "transport_error",
                "breaker_open",
                "delivered_first",
            }
            if type(kind) is not str or kind not in allowed:
                return
            report = {"kind": kind}
            for key in ("field", "setting", "code", "shape"):
                value = safe_fields.get(key)
                if (
                    type(value) is str
                    and len(value) <= 128
                    and all(c.isascii() and (c.isalnum() or c in "_.*-") for c in value)
                ):
                    report[key] = value
            for key in ("count", "status"):
                if type(safe_fields.get(key)) is int:
                    report[key] = safe_fields[key]
            if kind == "unredacted_secret_name":
                for key, limit in (("name", 128), ("path", 512)):
                    if type(safe_fields.get(key)) is str:
                        report[key] = safe_fields[key][:limit]
            first_warning = _claim_process_warning(kind, report)
            # Personal-data reports and printed warnings share the process
            # field/shape scope. Secret-name callbacks remain per recorder.
            if kind == "personal_data" and not first_warning:
                return
            now = time.monotonic()
            with self._lock:
                callback = self._callback
                log = self._logging and (
                    safe_fields.get("creation") is True
                    or now - self._last_log.get(kind, -float("inf")) >= 60
                )
                if log:
                    self._last_log[kind] = now
            if kind in ("personal_data", "unredacted_secret_name"):
                log = first_warning is True
            elif first_warning:
                log = True
            if callback:
                try:
                    callback(dict(report))
                except BaseException:
                    pass
            if log:
                try:
                    print(
                        "[wayscribe] "
                        + " ".join(
                            (
                                f"{k}={v}"
                                for k, v in report.items()
                                if k not in ("name", "path")
                            )
                        ),
                        file=sys.stderr,
                    )
                except BaseException:
                    pass
        except BaseException:
            pass
