"""Frozen 0.1 carriers. Extraction validates; injection never writes tracing."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._diagnostics import Diagnostics
import hashlib
import hmac
import re
from collections.abc import Mapping

from ._event import new_journey_id

HTTP = ("x-wayscribe-journey-id", "x-wayscribe-entity-type", "x-wayscribe-entity-id")
SQS = ("wayscribeJourneyId", "wayscribeEntityType", "wayscribeEntityId")
PAYLOAD = ("journeyId", "entityType", "entityId")
_VALUE = re.compile("^[A-Za-z0-9_.:@=+-]{1,256}$")


def _valid(value):
    return type(value) is str and _VALUE.fullmatch(value) is not None


def _context(journey, kind, identifier):
    if not _valid(journey) or not journey.startswith("jrn_"):
        return None
    result = {"journeyId": journey}
    if _valid(kind) and _valid(identifier):
        result["entity"] = {"type": kind, "id": identifier}
    return result


def _selected(context, level):
    if not isinstance(context, Mapping):
        return {}
    journey = context.get("journeyId")
    if type(journey) is not str:
        return {}
    result = {"journeyId": journey}
    entity = context.get("entity")
    if level != "journey-only" and isinstance(entity, Mapping):
        kind = entity.get("type")
        if type(kind) is str:
            result["entityType"] = kind
        identifier = entity.get("id")
        if level == "full" and _valid(identifier):
            result["entityId"] = identifier
    return result


def inject_http_headers(
    context: Mapping[str, Any],
    headers: Mapping[str, Any] | None = None,
    *,
    level: str = "journey-and-type",
) -> dict[str, Any]:
    try:
        result = {
            k: v
            for k, v in (headers.items() if isinstance(headers, Mapping) else ())
            if type(k) is str and k.lower() not in HTTP
        }
        result.update(
            {HTTP[PAYLOAD.index(k)]: v for k, v in _selected(context, level).items()}
        )
        return result
    except BaseException:
        return {}


def _http_value(headers, name):
    if isinstance(headers, Mapping):
        if name in headers:
            value = headers.get(name)
        else:
            value = next(
                (v for k, v in headers.items() if type(k) is str and k.lower() == name),
                None,
            )
    else:
        value = headers.get(name)
    if type(value) is list:
        value = value[0] if value else None
    return value if type(value) is str else None


def extract_http_context(headers: object) -> dict[str, Any] | None:
    try:
        return _context(*(_http_value(headers, key) for key in HTTP))
    except BaseException:
        return None


def inject_sqs_attributes(
    context: Mapping[str, Any],
    attributes: Mapping[str, Any] | None = None,
    *,
    level: str = "journey-and-type",
) -> dict[str, Any]:
    try:
        result = {
            k: v
            for k, v in (attributes.items() if isinstance(attributes, Mapping) else ())
            if k not in SQS
        }
        result.update(
            {
                SQS[PAYLOAD.index(k)]: {"DataType": "String", "StringValue": v}
                for k, v in _selected(context, level).items()
            }
        )
        return result
    except BaseException:
        return {}


def extract_sqs_context(attributes: object) -> dict[str, Any] | None:
    try:
        values = []
        for key in SQS:
            value = attributes.get(key)
            if isinstance(value, Mapping):
                value = value.get("StringValue")
            values.append(value)
        return _context(*values)
    except BaseException:
        return None


def inject_payload(
    context: Mapping[str, Any], data: Any, *, level: str = "journey-and-type"
) -> dict[str, Any]:
    try:
        return {"_wayscribe": _selected(context, level), "data": data}
    except BaseException:
        return {"_wayscribe": {}, "data": data}


def extract_payload(body: Any) -> dict[str, Any]:
    try:
        if not isinstance(body, Mapping) or "_wayscribe" not in body:
            return {"context": None, "data": body}
        source = body.get("_wayscribe")
        context = None
        if isinstance(source, Mapping):
            context = _context(*(source.get(k) for k in PAYLOAD))
        return {"context": context, "data": body.get("data")}
    except BaseException:
        return {"context": None, "data": body}


def has_journey(body: object) -> bool:
    try:
        value = body.get("_wayscribe").get("journeyId")
        return type(value) is str and bool(value)
    except BaseException:
        return False


def derive_journey_id(
    secret: str | None,
    environment: str,
    entity: object,
    diagnostics: Diagnostics | None = None,
) -> str:
    try:
        if type(secret) is not str or len(secret.encode("utf-8")) < 32:
            raise ValueError()
        if not isinstance(entity, Mapping):
            raise ValueError()
        values = ("journey-id/v1", environment, entity.get("type"), entity.get("id"))
        if any(type(x) is not str or not x for x in values):
            raise ValueError()
        mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
        for value in values:
            encoded = value.encode("utf-8")
            mac.update(len(encoded).to_bytes(4, "big"))
            mac.update(encoded)
        return "jrn_" + mac.hexdigest()[:32]
    except BaseException:
        if diagnostics is not None:
            diagnostics.emit("derivation_fallback", code="unusable_secret_or_entity")
        return new_journey_id()
