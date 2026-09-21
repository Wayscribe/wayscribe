"""Explicit, detached configuration; no network, threads or environment reads."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._diagnostics import Diagnostics
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from urllib.parse import urlsplit

UNREADABLE = object()
MISSING = object()
SAFE_INTEGER = 9007199254740991


def read(source: object, key: str, default: Any = MISSING) -> Any:
    try:
        return source.get(key, default) if isinstance(source, Mapping) else default
    except BaseException:
        return UNREADABLE


def valid_text(value: object, limit: int, *, blank: bool = False) -> bool:
    return (
        type(value) is str
        and 0 < len(value) <= limit
        and "\x00" not in value
        and not any(55296 <= ord(c) <= 57343 for c in value)
        and (
            blank
            or value.strip(
                "\ufeff \t\r\n\x0b\x0c\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
            )
            != ""
        )
    )


@dataclass(frozen=True, repr=False)
class Config:
    enabled: bool
    endpoint: str
    api_key: str
    service: str
    environment: str
    capture_mode: str = "redacted-payload"
    redact: tuple[str, ...] = ()
    known_safe_names: tuple[str, ...] = ()
    batch_size: int = 50
    flush_interval_ms: int = 1000
    request_timeout_ms: int = 1500
    max_buffered_events: int = 1000
    max_event_bytes: int = 262144
    max_concurrent_sends: int = 1
    max_attempts: int = 3
    backoff_base_ms: int = 100
    backoff_max_ms: int = 2000
    breaker_threshold: int = 5
    breaker_reset_ms: int = 30000
    event_retry_budget_ms: int = 30000
    event_retry_max_sends: int = 10
    propagation: str = "journey-and-type"
    journey_id_secret: str | None = None
    deployment: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))

    def __repr__(self):
        return f"Config(enabled={self.enabled})"


def resolve_config(options: Mapping[str, object], diagnostics: Diagnostics) -> Config:

    def reject(key):
        diagnostics.reject_setting(key)

    callback = read(options, "on_diagnostic")
    logging = read(options, "log_diagnostics")
    if callback is not MISSING or logging is not MISSING:
        diagnostics.configure(
            on_diagnostic=callback if callable(callback) else None,
            log_diagnostics=logging is True,
        )
    if callback is not MISSING and (not callable(callback)):
        reject("on_diagnostic")
    if logging is not MISSING and type(logging) is not bool:
        reject("log_diagnostics")

    def required(key, limit):
        value = read(options, key)
        if valid_text(value, limit):
            return value
        reject(key)
        return ""

    endpoint = required("endpoint", 65536)
    try:
        parsed = urlsplit(endpoint)
        usable = (
            parsed.scheme in ("http", "https")
            and bool(parsed.hostname)
            and (parsed.username is None)
            and (parsed.password is None)
            and (not parsed.query)
            and (not parsed.fragment)
            and (not any(ord(c) <= 32 or ord(c) == 127 for c in endpoint))
        )
        _ = parsed.port
    except BaseException:
        usable = False
    if endpoint and (not usable):
        reject("endpoint")
        endpoint = ""
    if endpoint.startswith("http://"):
        diagnostics.emit("insecure_endpoint")
    api_key = required("api_key", 65536)
    if api_key and any(ord(c) < 32 or ord(c) > 126 for c in api_key):
        reject("api_key")
        api_key = ""
    service = required("service", 128)
    environment = required("environment", 64)

    def choice(key, choices, default):
        value = read(options, key)
        if value is MISSING:
            return default
        if type(value) is str and value in choices:
            return value
        reject(key)
        return default

    def number(key, default, maximum=SAFE_INTEGER, clamp=False):
        value = read(options, key)
        if value is MISSING:
            return default
        if type(value) is int and 1 <= value <= maximum:
            return value
        reject(key)
        if clamp and type(value) is int:
            return min(max(value, 1), maximum)
        return default

    def names(key):
        value = read(options, key)
        if value is MISSING:
            return ()
        if type(value) not in (tuple, list):
            reject(key)
            return ()
        kept = []
        bad = len(value) > 1000
        for item in value[:1000]:
            if valid_text(item, 1024):
                kept.append(item)
            else:
                bad = True
        if bad:
            reject(key)
        return tuple(kept)

    from ._capture import fold

    redact = names("redact")
    known = tuple(fold(x) for x in names("known_safe_names"))
    secret = read(options, "journey_id_secret")
    if secret is MISSING:
        secret = None
    elif (
        type(secret) is not str
        or not valid_text(secret, 65536)
        or len(secret.encode("utf-8")) < 32
    ):
        reject("journey_id_secret")
        secret = None
    deployment = {}
    supplied = read(options, "deployment")
    if supplied is not MISSING:
        for local, wire, limit in (
            ("git_commit", "gitCommit", 128),
            ("version", "version", 128),
            ("image", "image", 512),
        ):
            value = read(supplied, local)
            if value is MISSING:
                continue
            if valid_text(value, limit):
                deployment[wire] = value
            else:
                reject("deployment." + local)
        try:
            if not isinstance(supplied, Mapping) or any(
                k not in ("git_commit", "version", "image") for k in supplied
            ):
                reject("deployment.*")
        except BaseException:
            reject("deployment.*")
        if not deployment:
            reject("deployment")
    for old in ("max_payload_bytes", "propagate", "max_concurrent_sends"):
        if read(options, old) is not MISSING:
            reject(old)
    return Config(
        enabled=all((endpoint, api_key, service, environment)),
        endpoint=endpoint,
        api_key=api_key,
        service=service,
        environment=environment,
        capture_mode=choice(
            "capture_mode",
            ("metadata-only", "redacted-payload", "full-payload"),
            "redacted-payload",
        ),
        redact=redact,
        known_safe_names=known,
        batch_size=number("batch_size", 50, 100, True),
        flush_interval_ms=number("flush_interval_ms", 1000, 2147483647),
        request_timeout_ms=number("request_timeout_ms", 1500, 2147483647),
        max_buffered_events=number("max_buffered_events", 1000),
        max_event_bytes=number("max_event_bytes", 262144, 262144, True),
        propagation=choice(
            "propagation",
            ("journey-only", "journey-and-type", "full"),
            "journey-and-type",
        ),
        journey_id_secret=secret,
        deployment=MappingProxyType(deployment),
    )
