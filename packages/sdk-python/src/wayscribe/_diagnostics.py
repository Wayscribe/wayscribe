"""Safe reports and independent, internally synchronized accounting.

Never call emit while holding the recorder/transport lock: callbacks may reenter
that recorder. Counter methods never invoke user code. Diagnostics never takes a
recorder lock, so transport may increment counters under its own lock.
"""

from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable
from typing import Any

DROP_CAUSES = ("queue_full", "after_shutdown", "shutdown", "retry_budget", "no_verdict")
_process_lock = threading.Lock()
_process_warnings = set()


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
            now = time.monotonic()
            with self._lock:
                callback = self._callback
                log = self._logging and (
                    safe_fields.get("creation") is True
                    or now - self._last_log.get(kind, -float("inf")) >= 60
                )
                if log:
                    self._last_log[kind] = now
            warning = kind in (
                "configuration_error",
                "personal_data",
                "derivation_fallback",
                "unredacted_secret_name",
            )
            if warning:
                token = (
                    kind,
                    report.get("setting"),
                    report.get("field"),
                    report.get("shape"),
                    report.get("name"),
                )
                with _process_lock:
                    if token not in _process_warnings and len(_process_warnings) < 2000:
                        _process_warnings.add(token)
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
