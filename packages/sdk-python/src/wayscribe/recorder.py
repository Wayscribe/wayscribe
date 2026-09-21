"""Public recorder and journey facade. Host callbacks are never inside a guard."""

from __future__ import annotations

import asyncio
import inspect
import os
import time
from collections.abc import Mapping
from typing import Any, Callable, Literal, TypeVar

from ._capture import TOO_LARGE, UNSET, Captured, capture
from ._config import Config, resolve_config, valid_text
from ._diagnostics import Diagnostics
from ._event import (
    build_envelope,
    capture_metadata,
    new_journey_id,
    normalize_label,
    now_timestamp,
)
from ._transport import Transport
from .propagation import derive_journey_id, extract_http_context
from .timing import queue_metadata

Operation = Literal[
    "received",
    "identified",
    "transformed",
    "validated",
    "persisted",
    "published",
    "consumed",
    "delivered",
    "failed",
    "retried",
    "completed",
]
T = TypeVar("T")


def create_recorder(**options: Any) -> Recorder:
    """Create a recorder; unusable settings produce a safe no-network recorder."""
    return Recorder(**options)


class Recorder:
    def __init__(self, **options: Any):
        self._pid = os.getpid()
        self._diagnostics = Diagnostics()
        try:
            self._config = resolve_config(options, self._diagnostics)
        except BaseException:
            self._config = Config(False, "", "", "", "")
            self._diagnostics.emit("configuration_error", code="unreadable")
        try:
            self._transport = Transport(self._config, self._diagnostics)
        except BaseException:
            self._config = Config(False, "", "", "", "")
            self._transport = Transport(self._config, self._diagnostics)
            self._diagnostics.emit("transport_error", code="startup")

    def _local(self):
        # Do not touch inherited diagnostics, condition locks, queues or sockets.
        return os.getpid() == self._pid

    def journey(
        self, entity: object, *, journey_id: str | None = None, label: str | None = None
    ) -> Journey:
        return Journey(self, entity, journey_id=journey_id, label=label)

    def resume(self, context: object, *, entity: object) -> Journey:
        identifier = None
        if self._local():
            try:
                parsed = extract_http_context(
                    {"x-wayscribe-journey-id": context.get("journeyId")}
                )
                if parsed and valid_text(parsed["journeyId"], 128, blank=True):
                    identifier = parsed["journeyId"]
                else:
                    self._diagnostics.emit("invalid_option", field="context")
            except BaseException:
                self._diagnostics.emit("invalid_option", field="context")
        return self.journey(entity, journey_id=identifier)

    def for_entity(self, entity: object, *, label: str | None = None) -> Journey:
        identifier = None
        if self._local():
            try:
                identifier = derive_journey_id(
                    self._config.journey_id_secret,
                    self._config.environment,
                    entity,
                    self._diagnostics,
                )
            except BaseException:
                self._diagnostics.emit("invalid_option", field="entity")
        return self.journey(entity, journey_id=identifier, label=label)

    def across(self, journeys: object) -> _Operations:
        targets = []
        if self._local():
            try:
                seen = set()
                for journey in journeys:
                    if (
                        type(journey) is Journey
                        and journey._recorder is self
                        and journey._journey_id not in seen
                    ):
                        targets.append(journey)
                        seen.add(journey._journey_id)
            except BaseException:
                self._diagnostics.emit("invalid_option", field="journeys")
        return _Operations(self, tuple(targets))

    def flush(self, timeout_ms: int = 5000) -> bool:
        if not self._local():
            return False
        try:
            return self._transport.flush(timeout_ms)
        except BaseException:
            return False

    def shutdown(self, timeout_ms: int = 5000) -> bool:
        if not self._local():
            return False
        try:
            return self._transport.shutdown(timeout_ms)
        except BaseException:
            return False

    async def async_flush(self, timeout_ms: int = 5000) -> bool:
        if not self._local():
            return False
        try:
            return await self._transport.async_flush(timeout_ms)
        except asyncio.CancelledError:
            raise
        except BaseException:
            return False

    async def async_shutdown(self, timeout_ms: int = 5000) -> bool:
        if not self._local():
            return False
        try:
            return await self._transport.async_shutdown(timeout_ms)
        except asyncio.CancelledError:
            raise
        except BaseException:
            return False

    def counters(self) -> dict[str, Any]:
        if not self._local():
            return Diagnostics().counters()
        try:
            return self._diagnostics.counters()
        except BaseException:
            return Diagnostics().counters()

    def rejected_settings(self) -> tuple[str, ...]:
        if not self._local():
            return ()
        try:
            return self._diagnostics.rejected_settings()
        except BaseException:
            return ()

    def __enter__(self) -> Recorder:
        return self

    def __exit__(self, *exc) -> bool:
        self.shutdown()
        return False

    async def __aenter__(self) -> Recorder:
        return self

    async def __aexit__(self, *exc) -> bool:
        await self.async_shutdown()
        return False

    def _record(self, target, fields):
        if not self._local():
            return
        try:
            with self._transport._condition:
                label = target._label
            fields = dict(fields)
            if label is not None:
                fields.setdefault("journey_label", label)
            body = build_envelope(
                self._config,
                self._diagnostics,
                journey_id=target._journey_id,
                entity=target._entity,
                **fields,
            )
            if body is not None:
                self._transport.enqueue(body)
        except BaseException:
            self._diagnostics.emit("capture_error", code="record_failed")


class _Operations:
    def __init__(self, recorder, targets):
        self._recorder = recorder
        self._targets = targets

    def record(self, *, operation: Operation, name: str, **event_fields: Any) -> None:
        if not self._recorder._local():
            return
        try:
            fields = dict(event_fields, operation=operation, name=name)
            fields.setdefault("timestamp", now_timestamp())
            self._snapshot_aliases(fields)
            if "metadata" in fields:
                fields["metadata"] = capture_metadata(
                    fields["metadata"],
                    self._recorder._config,
                    self._recorder._diagnostics,
                )
            # Across calls also snapshot once before diagnostic callbacks can
            # modify caller-owned data between the individual journey events.
            for field in ("input", "output"):
                if field in fields and type(fields[field]) is not Captured:
                    fields[field] = capture(
                        fields[field], self._recorder._config, field_name=field
                    )
            for target in self._targets:
                self._recorder._record(target, fields)
        except BaseException:
            self._recorder._diagnostics.emit("capture_error", code="record_failed")

    def fail(self, name: str, error: object, **options: Any) -> None:
        self.record(operation="failed", name=name, error=error, **options)

    def complete(self, name: str = "complete", **options: Any) -> None:
        self.record(operation="completed", name=name, **options)

    def transform(
        self, name: str, input: object, callback: Callable[[], T], **options: Any
    ) -> T:
        return self._wrap("transformed", name, input, callback, options)

    def persist(
        self, name: str, input: object, callback: Callable[[], T], **options: Any
    ) -> T:
        return self._wrap("persisted", name, input, callback, options)

    def publish(
        self, name: str, input: object, callback: Callable[[], T], **options: Any
    ) -> T:
        return self._wrap("published", name, input, callback, options)

    def consume(
        self, name: str, input: object, callback: Callable[[], T], **options: Any
    ) -> T:
        return self._wrap("consumed", name, input, callback, options)

    def deliver(
        self, name: str, input: object, callback: Callable[[], T], **options: Any
    ) -> T:
        return self._wrap("delivered", name, input, callback, options)

    def validate(
        self, name: str, input: object, callback: Callable[[], T], **options: Any
    ) -> T:
        return self._wrap("validated", name, input, callback, options)

    def _wrap(self, operation, name, input, callback, options):
        recorder = self._recorder
        prepared = []
        started, timestamp = None, UNSET
        if recorder._local() and recorder._config.enabled:
            try:
                started, timestamp = time.monotonic(), now_timestamp()
                metadata = options.get("metadata", UNSET)
                if metadata is not UNSET:
                    metadata = capture_metadata(
                        metadata, recorder._config, recorder._diagnostics
                    )
                if "queue_job" in options:
                    extra = queue_metadata(
                        options["queue_job"],
                        ready_again_at=options.get("ready_again_at"),
                        delivery_count=options.get("delivery_count"),
                    )
                    metadata = self._merge_metadata(metadata, extra)
                saved = dict(options)
                self._snapshot_aliases(saved)
                for target in self._targets:
                    fields = {
                        k: v
                        for k, v in saved.items()
                        if k
                        not in (
                            "capture_input",
                            "capture_output",
                            "is_failure",
                            "metadata_from",
                            "queue_job",
                            "ready_again_at",
                            "delivery_count",
                            "metadata",
                        )
                    }
                    fields.update(operation=operation, name=name, timestamp=timestamp)
                    if metadata is not UNSET:
                        fields["metadata"] = metadata
                    fields["input"] = self._project(
                        options.get("capture_input"), input, target, "input"
                    )
                    prepared.append((target, fields))
            except BaseException:
                recorder._diagnostics.emit("capture_error", code="wrapper_prepare")

        def finish(result=UNSET, error=UNSET):
            if not recorder._local():
                return
            try:
                duration = (
                    max(0, int((time.monotonic() - started) * 1000))
                    if started is not None
                    else 0
                )
                if error is UNSET and "is_failure" in options:
                    try:
                        verdict = options["is_failure"](result)
                        if inspect.isawaitable(verdict):
                            _close_coroutine(verdict)
                            raise ValueError()
                        error = _failure(verdict, name)
                    except BaseException:
                        recorder._diagnostics.increment("capture_errors")
                        recorder._diagnostics.emit("capture_error", field="is_failure")
                for target, fields in prepared:
                    try:
                        fields["duration_ms"] = duration
                        if error is not UNSET:
                            fields["error"] = error
                        if result is not UNSET:
                            fields["output"] = self._project(
                                options.get("capture_output"), result, target, "output"
                            )
                            if "metadata_from" in options:
                                try:
                                    extra = _projection(
                                        options["metadata_from"],
                                        result,
                                        target.context(),
                                    )
                                    if not isinstance(extra, Mapping):
                                        raise ValueError()
                                    fields["metadata"] = self._merge_metadata(
                                        fields.get("metadata", UNSET), extra
                                    )
                                except BaseException:
                                    recorder._diagnostics.increment("capture_errors")
                                    recorder._diagnostics.emit(
                                        "capture_error", field="metadata"
                                    )
                        recorder._record(target, fields)
                    except BaseException:
                        recorder._diagnostics.emit(
                            "capture_error", code="wrapper_finish"
                        )
            except BaseException:
                recorder._diagnostics.emit("capture_error", code="wrapper_finish")

        # Only this try catches host work, and always rethrows the exact object.
        try:
            produced = callback()
        except BaseException as error:
            finish(error=error)
            raise
        try:
            awaitable = inspect.isawaitable(produced)
        except BaseException:
            awaitable = False
            if recorder._local():
                recorder._diagnostics.emit("capture_error", code="result_type")
        if awaitable:

            async def await_result():
                try:
                    result = await produced
                except BaseException as error:
                    finish(error=error)
                    raise
                finish(result=result)
                return result

            return await_result()
        finish(result=produced)
        return produced

    def _snapshot_aliases(self, fields):
        if "aliases" in fields:
            supplied = fields["aliases"]
            snapshot = {}
            fields["aliases"] = snapshot
            try:
                if not isinstance(supplied, Mapping) or len(supplied) > 1000:
                    raise ValueError()
                for index, key in enumerate(supplied):
                    if index >= 1000:
                        self._recorder._diagnostics.emit(
                            "invalid_option", field="aliases"
                        )
                        break
                    # Do not hash caller-owned arbitrary objects while copying.
                    # The event builder validates the retained strings/values.
                    if type(key) is str:
                        snapshot[key] = supplied[key]
                    else:
                        self._recorder._diagnostics.emit(
                            "invalid_option", field="aliases"
                        )
            except BaseException:
                self._recorder._diagnostics.emit("invalid_option", field="aliases")
        if "displayable_aliases" in fields and type(fields["displayable_aliases"]) in (
            list,
            tuple,
        ):
            fields["displayable_aliases"] = tuple(fields["displayable_aliases"][:1000])

    def _merge_metadata(self, snapshot, extra):
        # Capture before merging: the core checks size before reading values and
        # caps iteration even for mappings that misreport their length.
        projected = capture_metadata(
            extra, self._recorder._config, self._recorder._diagnostics
        )
        if projected is None:
            return snapshot
        previous = (
            snapshot.value
            if type(snapshot) is Captured and type(snapshot.value) is dict
            else {}
        )
        if type(snapshot) is Captured:
            projected.truncated |= snapshot.truncated
            projected.omitted |= snapshot.omitted
            projected.unreadable |= snapshot.unreadable
            projected.names = [*snapshot.names, *projected.names]
        if projected.omitted:
            projected.value = TOO_LARGE
            return projected
        # Both sides are detached, bounded dictionaries. Check their union
        # without constructing a dictionary larger than the protocol permits.
        combined = dict(previous)
        for key, value in projected.value.items():
            if key not in combined and len(combined) >= 1000:
                projected.value = TOO_LARGE
                projected.omitted = True
                return projected
            combined[key] = value
        projected.value = combined
        return projected

    def _project(self, projection, value, target, field):
        try:
            if projection is not None:
                value = _projection(projection, value, target.context())
            return capture(value, self._recorder._config, field_name=field)
        except BaseException:
            return Captured("[UNCAPTURABLE]", unreadable=True)


class Journey(_Operations):
    def __init__(
        self,
        recorder: Recorder,
        entity: object,
        *,
        journey_id: str | None = None,
        label: str | None = None,
    ):
        self._recorder = recorder
        self._targets = (self,)
        self._label = None
        self._entity = {}
        self._journey_id = journey_id
        try:
            if journey_id is None:
                self._journey_id = new_journey_id()
            if isinstance(entity, Mapping):
                self._entity = {"type": entity.get("type"), "id": entity.get("id")}
            if label is not None:
                self.label(label)
        except BaseException:
            if recorder._local():
                recorder._diagnostics.emit("invalid_option", field="entity")

    def context(self) -> dict[str, Any]:
        return {"journeyId": self._journey_id, "entity": dict(self._entity)}

    def label(self, value: str) -> None:
        if not self._recorder._local():
            return
        try:
            normalized = normalize_label(value, self._recorder._diagnostics)
            if normalized is not None:
                with self._recorder._transport._condition:
                    self._label = normalized
        except BaseException:
            self._recorder._diagnostics.emit("invalid_option", field="journey_label")

    def identify(self, aliases: object, *, displayable_aliases=()) -> None:
        self.record(
            operation="identified",
            name="identify",
            aliases=aliases,
            displayable_aliases=displayable_aliases,
        )


def _close_coroutine(value):
    if inspect.iscoroutine(value):
        value.close()


def _projection(callback, value, context):
    # Choose the arity before invoking; never retry a callback that raised a
    # TypeError inside its body. A second argument is an optional context view.
    try:
        signature = inspect.signature(callback)
        signature.bind(value, context)
    except (ValueError, TypeError):
        projected = callback(value)
    else:
        projected = callback(value, context)
    if inspect.isawaitable(projected):
        _close_coroutine(projected)
        raise ValueError()
    return projected


def _failure(verdict, name):
    if not verdict:
        return UNSET
    generic = f"{name} reported a failed result."
    if type(verdict) is str:
        return {"message": verdict, "code": "result_failed"}
    if isinstance(verdict, Mapping):
        message, code = verdict.get("message"), verdict.get("code")
        return {
            "message": message if type(message) is str and message else generic,
            "code": code if type(code) is str and code else "result_failed",
        }
    return {"message": generic, "code": "result_failed"}
