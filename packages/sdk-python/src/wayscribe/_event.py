"""Protocol validation and final envelope fitting; delivery accounting is external."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._config import Config
    from ._diagnostics import Diagnostics
import datetime as dt
import platform
import uuid
from collections.abc import Mapping
from dataclasses import replace

from ._capture import TOO_LARGE, UNSET, Captured, capture, json_bytes, repair_text
from ._config import valid_text
from ._errors import capture_error, public_warning
from ._version import SDK_COMMIT, SDK_NAME, __version__

OPERATIONS = frozenset(
    [
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
)


def now_timestamp() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def new_journey_id() -> str:
    return "jrn_" + str(uuid.uuid4())


def normalize_label(value: object, diagnostics: Diagnostics) -> str | None:
    if type(value) is not str:
        diagnostics.emit("invalid_option", field="journey_label")
        return None
    value = repair_text(value)
    if not valid_text(value, max(200, len(value))):
        diagnostics.emit("invalid_option", field="journey_label")
        return None
    if len(value) > 200:
        value = value[:199] + "…"
        diagnostics.emit("invalid_option", field="journey_label", code="truncated")
    public_warning(value, "journey_label", diagnostics)
    return value


def build_envelope(
    config: Config,
    diagnostics: Diagnostics,
    *,
    journey_id: object,
    entity: object,
    operation: object,
    name: object,
    **fields: Any,
) -> bytes | None:
    try:
        return _build(config, diagnostics, journey_id, entity, operation, name, fields)
    except BaseException:
        diagnostics.emit("invalid_event", code="unreadable")
        return None


def capture_metadata(
    metadata: object, config: Config, diagnostics: Diagnostics
) -> Captured | None:
    """Snapshot validated metadata before host work, preserving capture evidence."""
    if type(metadata) is Captured:
        result = replace(metadata)
        if type(result.value) is dict:
            result.value = dict(result.value)
        return result
    try:
        if not isinstance(metadata, Mapping):
            raise ValueError()
        if len(metadata) > 1000:
            return Captured(TOO_LARGE, omitted=True)
        normalized = {}
        dropped = 0
        for index, key in enumerate(metadata):
            if index >= 1000:
                return Captured(TOO_LARGE, omitted=True)
            if type(key) is str and len(key) <= 128:
                normalized[repair_text(key)] = metadata[key]
            else:
                dropped += 1
        if dropped:
            normalized["[KEY_TOO_LONG]"] = dropped
            diagnostics.emit("invalid_option", field="metadata")
        return capture(normalized, config, field_name="metadata")
    except BaseException:
        diagnostics.emit("capture_error", field="metadata")
        return None


def _build(config, diagnostics, journey_id, entity, operation, name, fields):
    if not config.enabled:
        return None
    # Read caller-owned mappings once. Diagnostics below may reenter the host
    # and mutate them; the wire must contain exactly the strings validated here.
    entity_type = entity.get("type") if isinstance(entity, Mapping) else None
    entity_id = entity.get("id") if isinstance(entity, Mapping) else None
    if not (
        valid_text(journey_id, 128, blank=True)
        and valid_text(entity_type, 128, blank=True)
        and valid_text(entity_id, 512, blank=True)
        and (type(operation) is str)
        and (operation in OPERATIONS)
        and valid_text(name, 256, blank=True)
    ):
        diagnostics.emit("invalid_event", code="identity")
        return None
    timestamp = fields.get("timestamp", UNSET)
    if timestamp is UNSET:
        timestamp = now_timestamp()
    try:
        parsed = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        timestamp = (
            parsed.astimezone(dt.timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    except BaseException:
        diagnostics.emit("invalid_option", field="timestamp")
        timestamp = now_timestamp()
    sdk = {"name": SDK_NAME, "version": __version__}
    if SDK_COMMIT:
        sdk["commit"] = SDK_COMMIT
    event = {
        "id": "evt_" + str(uuid.uuid4()),
        "journeyId": journey_id,
        "entity": {"type": entity_type, "id": entity_id},
        "operation": operation,
        "name": name,
        "timestamp": timestamp,
        "service": config.service,
        "environment": config.environment,
        "runtime": {
            "language": "python",
            "version": platform.python_version(),
            "sdk": sdk,
        },
    }
    if config.deployment:
        event["deployment"] = dict(config.deployment)
    for local, wire, limit in (
        ("parent_event_id", "parentEventId", 128),
        ("trace_id", "traceId", 128),
        ("span_id", "spanId", 128),
        ("message_id", "messageId", 256),
        ("correlation_id", "correlationId", 256),
    ):
        value = fields.get(local, UNSET)
        if value is UNSET:
            continue
        if (
            type(value) is str
            and len(value) <= limit
            and "\x00" not in value
            and not any(55296 <= ord(x) <= 57343 for x in value)
        ):
            event[wire] = value
        else:
            diagnostics.emit("invalid_option", field=local)
    duration = fields.get("duration_ms", UNSET)
    if type(duration) in (int, float) and duration >= 0 and (duration < float("inf")):
        event["durationMs"] = min(int(duration), 2147483647)
    elif duration is not UNSET:
        diagnostics.emit("invalid_option", field="duration_ms")
    label = fields.get("journey_label", UNSET)
    if label is not UNSET:
        label = normalize_label(label, diagnostics)
        if label is not None:
            event["journeyLabel"] = label
    error = fields.get("error", UNSET)
    if error is not UNSET and error is not None:
        event["error"] = capture_error(error, diagnostics)
    aliases = fields.get("aliases", UNSET)
    if aliases is not UNSET:
        kept = {}
        try:
            if not isinstance(aliases, Mapping) or len(aliases) > 1000:
                raise ValueError()
            for index, key in enumerate(aliases):
                if index >= 1000:
                    diagnostics.emit("invalid_option", field="aliases")
                    break
                value = aliases[key]
                if (
                    type(key) is str
                    and len(key) <= 128
                    and (type(value) is str)
                    and (len(value) <= 512)
                ):
                    kept[repair_text(key)] = repair_text(value)
                else:
                    diagnostics.emit("invalid_option", field="aliases")
        except BaseException:
            diagnostics.emit("invalid_option", field="aliases")
        event["aliases"] = kept
        display = fields.get("displayable_aliases", ())
        if type(display) not in (tuple, list):
            diagnostics.emit("invalid_option", field="displayable_aliases")
            display = ()
        usable = []
        for key in display[:1000]:
            if type(key) is str and key in kept and (key not in usable):
                usable.append(key)
                public_warning(kept[key], "displayable_alias", diagnostics)
        if usable:
            event["displayableAliases"] = usable
    captures = {}
    metadata = fields.get("metadata", UNSET)
    if metadata is not UNSET:
        result = capture_metadata(metadata, config, diagnostics)
        if result is not None:
            captures["metadata"] = result
    attempt = fields.get("attempt", UNSET)
    if type(attempt) is int and 1 <= attempt <= 9007199254740991:
        if attempt > 1:
            event["operation"] = "retried"
        if "metadata" not in captures:
            captures["metadata"] = Captured({})
        if type(captures["metadata"].value) is dict:
            captures["metadata"].value["attempt"] = attempt
        if (
            type(captures["metadata"].value) is dict
            and len(captures["metadata"].value) > 1000
        ):
            captures["metadata"] = Captured(TOO_LARGE, omitted=True)
    elif attempt is not UNSET:
        diagnostics.emit("invalid_option", field="attempt")
    if config.capture_mode != "metadata-only":
        for key in ("input", "output"):
            value = fields.get(key, UNSET)
            if value is not UNSET:
                captures[key] = (
                    replace(value)
                    if isinstance(value, Captured)
                    else capture(value, config, field_name=key)
                )
    for key, result in captures.items():
        if key != "metadata" or not result.omitted:
            event[key] = result.value

    def wire():
        return json_bytes({"protocolVersion": "0.1", "event": event})

    body = wire()
    for key in sorted(
        (key for key in ("input", "output") if key in event),
        key=lambda key: len(json_bytes(event[key])),
        reverse=True,
    ):
        if len(body) <= config.max_event_bytes:
            break
        event[key] = TOO_LARGE
        captures[key].omitted = True
        body = wire()
    if len(body) > config.max_event_bytes and "metadata" in event:
        del event["metadata"]
        captures["metadata"].omitted = True
        body = wire()
    for key, result in captures.items():
        if result.omitted:
            diagnostics.increment("payloads_omitted")
            diagnostics.emit("payload_omitted", field=key)
        elif result.truncated:
            diagnostics.increment("payloads_truncated")
            diagnostics.emit("payload_truncated", field=key)
        if result.unreadable:
            diagnostics.increment("capture_errors")
            diagnostics.emit("capture_error", field=key)
        if not result.omitted:
            for observed_name, path in result.names:
                diagnostics.report_name(
                    key,
                    observed_name,
                    f"{key}.{path}" if path else key,
                )
    if len(body) > config.max_event_bytes:
        diagnostics.emit("invalid_event", code="envelope_budget")
        return None
    return body
