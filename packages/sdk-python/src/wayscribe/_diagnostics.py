"""Safe reports and independent, internally synchronized accounting.

Never call emit while holding the recorder/transport lock: callbacks may reenter
that recorder. Counter methods never invoke user code. Diagnostics never takes a
recorder lock, so transport may increment counters under its own lock.

A report is ``{"kind", "code", "reason", "detail"}``, with the kind and code
names of the Node SDK (docs/SDK_SPEC.md, "Diagnostics across SDKs").
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any

DROP_CAUSES = ("queue_full", "after_shutdown", "shutdown", "retry_budget", "no_verdict")
# As the Node SDK: at most 100 secret-looking names remembered per recorder, a
# name kept to 128 characters and its path to 256, and a long folded name
# remembered as a digest, so hostile key names cannot grow host memory.
MAX_SECRET_NAMES = 100
MAX_SECRET_NAME_LENGTH = 128
MAX_SECRET_PATH_LENGTH = 256
_MAX_REMEMBERED_LENGTH = 256
_MAX_PRINTED_REASON = 512
_MAX_PENDING_CALLBACKS = 1000
_SAFE_TEXT = re.compile(r"[A-Za-z0-9_.*:\[\]-]{1,128}\Z")
# The only detail a report carries: numbers, names the SDK itself chose, and
# the three strings it bounds itself (a key name, its path, and an origin).
_INT_KEYS = frozenset(
    (
        "strings",
        "charactersRemoved",
        "keys",
        "failures",
        "cooldownMs",
        "unsent",
        "abandoned",
        "accepted",
    )
)
_TEXT_KEYS = frozenset(("field", "setting", "shape", "host", "scheme"))
_BOUNDED_KEYS = frozenset(("name", "path", "endpoint"))
_UNPRINTABLE = re.compile(
    "[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+"
)

_process_lock = threading.Lock()
_process_warnings: set[tuple[str, ...]] = set()


class _Dispatcher:
    """Runs callbacks for reports raised on the sender thread, off that thread.

    One lazily started daemon thread per process, holding only (owner,
    callback, report) entries, so a slow ``on_diagnostic`` delays other
    callbacks but never delivery, and a process that never needs it has no
    thread for it. At most 1,000 callbacks wait; past that a report still
    counts but its callback is skipped.
    """

    def __init__(self):
        self.condition = threading.Condition(threading.Lock())
        self.pending = deque()
        self.thread = None

    def submit(self, owner, callback, report):
        with self.condition:
            if len(self.pending) >= _MAX_PENDING_CALLBACKS:
                return
            self.pending.append((owner, callback, report))
            owner._pending_callbacks += 1
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(
                    target=self._run, name="wayscribe-diagnostics", daemon=True
                )
                self.thread.start()
            self.condition.notify_all()

    def _run(self):
        while True:
            with self.condition:
                while not self.pending:
                    self.condition.wait()
                owner, callback, report = self.pending.popleft()
            try:
                callback(report)
            except Exception:
                pass
            finally:
                with self.condition:
                    owner._pending_callbacks -= 1
                    self.condition.notify_all()
                owner = callback = report = None

    def drain(self, owner, deadline):
        with self.condition:
            if threading.current_thread() is self.thread:
                return
            while owner._pending_callbacks > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self.condition.wait(remaining)


_dispatcher = _Dispatcher()


def _reset_process_state_after_fork() -> None:
    # A vanished parent thread may own the inherited locks. Fresh recorders in
    # the child must use fresh process-local state without touching them.
    global _process_lock, _process_warnings, _dispatcher
    _process_lock = threading.Lock()
    _process_warnings = set()
    _dispatcher = _Dispatcher()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_process_state_after_fork)


def remembered_name(name: str) -> str:
    """A name as it is remembered: folded, or a digest of a long folded name."""
    from ._capture import fold

    folded = fold(name)
    if len(folded) <= _MAX_REMEMBERED_LENGTH:
        return folded
    return "#" + hashlib.sha256(folded.encode("utf-8", "replace")).hexdigest()


def _claim_process_warning(kind: str, code: str, detail: dict[str, Any]):
    """Claim a bounded warning identity printed once per process, or None."""
    if kind == "unredacted_secret_name":
        token = (kind, remembered_name(detail.get("name", "")))
    elif kind == "personal_data_in_public_value":
        token = (kind, detail.get("field", ""), detail.get("shape", ""))
    elif kind == "configuration_error" and code == "required_setting_unusable":
        token = (kind, detail.get("setting", ""))
    elif kind == "configuration_error" and code in (
        "journey_id_secret_missing",
        "journey_id_secret_unusable",
    ):
        token = (kind, "journey_id_secret")
    else:
        return None
    with _process_lock:
        if token in _process_warnings or len(_process_warnings) >= 2000:
            return False
        _process_warnings.add(token)
        return True


def _plural(count: object, word: str) -> str:
    return f"{count} {word}" + ("" if count == 1 else "s")


def _secret_advice(name: str) -> str:
    if any(c in name for c in ".*[]"):
        return (
            'No redaction rule can name a key containing ".", "*", "[" or "]": if it '
            "holds a secret, rename it or leave it out of what you record; if it "
            f'does not, add "{name}" to known_safe_names.'
        )
    return (
        f'If it holds a secret, add "**.{name}" to redact; '
        f'if it does not, add "{name}" to known_safe_names.'
    )


_CONFIGURATION_REASONS = {
    "required_setting_unusable": (
        "The required setting {setting} is missing or unusable, so this recorder "
        "sends nothing."
    ),
    "setting_renamed": "The setting {setting} is not read by this SDK.",
    "journey_id_secret_missing": (
        "No journey_id_secret is configured, so for_entity() used a random journey "
        "id and the entity's events will not share a journey."
    ),
    "journey_id_secret_unusable": (
        "journey_id_secret must be a string of at least 32 bytes; for_entity() "
        "used a random journey id."
    ),
    "entity_invalid": (
        "The entity needs a non-empty string type and id; a random journey id was "
        "used."
    ),
    "journey_id_invalid": (
        "The context holds no usable journey id; a new journey was started."
    ),
}


def _reason(kind: str, code: str, d: dict[str, Any]) -> str:
    """A sentence for a person, built only from the SDK's own safe values."""
    field = d.get("field", "a field")
    if kind == "delivered_first":
        return (
            f"Connected to {d.get('endpoint')}; the server accepted "
            f"{_plural(d.get('accepted'), 'event')}."
        )
    if kind == "insecure_endpoint":
        return (
            f"The endpoint is http: to {d.get('host')}, so the API key and payloads "
            "travel unencrypted. Use https: for any endpoint off this machine."
        )
    if kind == "breaker_opened":
        return (
            f"{_plural(d.get('failures'), 'send')} failed in a row, so sends pause "
            f"for {d.get('cooldownMs')} ms."
        )
    if kind == "transport_error":
        if code == "refused_for_now":
            return (
                "The server could not store "
                f"{_plural(d.get('unsent'), 'event')} for now; they are sent again."
            )
        if code == "unexpected_error":
            return "The recorder's own send path failed; events are not sent."
        return (
            f"A send failed; {_plural(d.get('unsent'), 'event')} go back to the queue."
        )
    if kind == "dropped":
        return {
            "queue_full": "The queue was full, so its oldest event was dropped.",
            "after_shutdown": "An event was recorded after shutdown and not sent.",
        }.get(code, "An event was not delivered.")
    if kind == "payload_omitted":
        return (
            f"The {field} payload was left out or replaced with a marker to fit the "
            "event's byte budget; the event is still sent."
        )
    if kind == "payload_truncated":
        if code == "label_cut":
            return "The journey label was cut to 200 characters."
        return (
            f"{_plural(d.get('strings'), 'string')} in {field} were cut to the "
            "server's limit; the event is still sent."
        )
    if kind == "key_dropped":
        if code == "label_invalid":
            return "The journey label is not a usable string and was not set."
        return (
            f"Entries of {field} the server would refuse were left off; the event "
            "is still sent."
        )
    if kind == "capture_error":
        if code == "not_a_journey":
            return "Something given to across() is not a journey of this recorder."
        return (
            "A call could not record what it was asked to; the host's call was "
            "unaffected."
        )
    if kind == "configuration_error":
        template = _CONFIGURATION_REASONS.get(
            code, "The setting {setting} could not be used; a safe default applies."
        )
        return template.format(setting=d.get("setting", "(unnamed)"))
    if kind == "unredacted_secret_name":
        name = d.get("name", "")
        return (
            f'A field named "{name}" (at {d.get("path", "")}) looks like a secret '
            "and was sent unredacted. " + _secret_advice(name)
        )
    if kind == "personal_data_in_public_value":
        what = "an email address" if d.get("shape") == "email" else "a telephone number"
        return (
            f"The {field} holds what looks like {what}; it is stored and shown in "
            "plain text."
        )
    return "The recorder reported a problem."


def _printable(reason: str) -> str:
    """One safe line: credential shapes masked, control characters replaced."""
    from ._errors import mask_text

    flat = _UNPRINTABLE.sub(" ", mask_text(reason[: 2 * _MAX_PRINTED_REASON]))
    if len(flat) <= _MAX_PRINTED_REASON:
        return flat
    return flat[:_MAX_PRINTED_REASON] + "[TRUNCATED]"


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
        self._pending_callbacks = 0

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

    def reject_setting(self, setting: str, code: str = "setting_unusable") -> None:
        with self._lock:
            self._settings.add(setting)
        self.increment("configuration_errors")
        self.emit("configuration_error", code, {"setting": setting}, creation=True)

    def report_name(self, field: str, name: str, path: str) -> None:
        remembered = remembered_name(name)
        with self._lock:
            if remembered in self._names or len(self._names) >= MAX_SECRET_NAMES:
                return
            self._names.add(remembered)
        self.increment("unredacted_secret_names")
        self.emit(
            "unredacted_secret_name",
            "secret_like_name",
            {
                "field": field,
                "name": name[:MAX_SECRET_NAME_LENGTH],
                "path": path[:MAX_SECRET_PATH_LENGTH],
            },
        )

    def drain_callbacks(self, deadline: float) -> None:
        """Wait, until the monotonic deadline, for deferred callbacks to run."""
        try:
            _dispatcher.drain(self, deadline)
        except Exception:
            pass

    def emit(
        self,
        kind: str,
        code: str,
        detail: dict[str, Any] | None = None,
        *,
        creation: bool = False,
        deferred: bool = False,
    ) -> None:
        """Report; ``deferred`` runs the callback off the calling thread."""
        try:
            if type(kind) is not str or type(code) is not str:
                return
            safe = {}
            for key, value in (detail or {}).items():
                if key in _INT_KEYS:
                    if type(value) is int:
                        safe[key] = value
                elif key in _BOUNDED_KEYS:
                    if type(value) is str:
                        safe[key] = value
                elif key in _TEXT_KEYS:
                    if type(value) is str and _SAFE_TEXT.match(value):
                        safe[key] = value
            report = {
                "kind": kind,
                "code": code,
                "reason": _reason(kind, code, safe),
                "detail": safe,
            }
            first_warning = _claim_process_warning(kind, code, safe)
            # Personal-data reports and printed warnings share the process
            # field/shape scope. Secret-name callbacks remain per recorder.
            if kind == "personal_data_in_public_value" and not first_warning:
                return
            now = time.monotonic()
            with self._lock:
                callback = self._callback
                # Once-per-recorder kinds and secret names are never rate
                # limited: each line is a different thing to fix.
                log = self._logging and (
                    creation
                    or kind
                    in (
                        "delivered_first",
                        "insecure_endpoint",
                        "unredacted_secret_name",
                    )
                    or now - self._last_log.get(kind, -float("inf")) >= 60
                )
                if log:
                    self._last_log[kind] = now
            if kind == "personal_data_in_public_value":
                log = first_warning is True
            elif first_warning:
                log = True
            # Built before the callback, which receives the report to keep.
            line = f"[wayscribe] {kind}: {_printable(report['reason'])}" if log else ""
            if callback:
                if deferred:
                    _dispatcher.submit(self, callback, report)
                else:
                    try:
                        callback(report)
                    except Exception:
                        pass
            if log:
                try:
                    print(line, file=sys.stderr)
                except Exception:
                    pass
        except Exception:
            pass
