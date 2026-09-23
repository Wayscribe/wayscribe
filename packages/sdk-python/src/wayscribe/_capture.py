"""Bounded synchronous capture. Walk only explicit containers, never attributes."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ._config import Config
import base64
import datetime as dt
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal

from ._diagnostics import (
    MAX_SECRET_NAME_LENGTH,
    MAX_SECRET_NAMES,
    MAX_SECRET_PATH_LENGTH,
)

UNSET = object()
REDACTED = "[REDACTED]"
TOO_LARGE = "[PAYLOAD_TOO_LARGE]"
UNCAPTURABLE = "[UNCAPTURABLE]"
SECRET_NAMES = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "password",
    "access_token",
    "refresh_token",
    "client_secret",
    "api_key",
    "secret",
    "stripe-signature",
    "x-hub-signature",
    "x-hub-signature-256",
    "x-slack-signature",
    "x-hubspot-signature",
    "x-hubspot-signature-v3",
    "x-twilio-signature",
    "x-shopify-hmac-sha256",
]


def fold(name: str) -> str:
    return name.lower().replace("-", "").replace("_", "")


SECRETS = frozenset(map(fold, SECRET_NAMES))
KNOWN_HEADERS = frozenset(
    [
        ":authority",
        ":method",
        ":path",
        ":protocol",
        ":scheme",
        ":status",
        "accept",
        "accept-encoding",
        "accept-language",
        "authorization",
        "cache-control",
        "connection",
        "content-length",
        "content-type",
        "cookie",
        "date",
        "etag",
        "host",
        "if-none-match",
        "location",
        "origin",
        "proxy-authorization",
        "referer",
        "set-cookie",
        "transfer-encoding",
        "user-agent",
        "vary",
        "www-authenticate",
        "x-api-key",
        "x-forwarded-for",
        "x-request-id",
    ]
)
TOKEN = re.compile("^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


def repair_text(text: str) -> str:
    return (
        text.replace("\x00", "")
        .encode("utf-16-le", "surrogatepass")
        .decode("utf-16-le", "replace")
    )


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def truncate_text(text: str, limit: int = 65536) -> str:
    encoded = text.encode("utf-16-le")
    length = len(encoded) // 2
    if length <= limit:
        return text
    separator = "\r\n" if "\r\n" in text else ""
    removed = length - limit
    while True:
        marker = separator + f"[TRUNCATED: {removed} characters removed]"
        kept = max(0, limit - len(marker))
        settled = length - kept
        if settled == removed:
            return encoded[: kept * 2].decode("utf-16-le", "replace") + marker[:limit]
        removed = settled


def json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")


@dataclass
class Captured:
    value: object
    truncated: bool = False
    omitted: bool = False
    unreadable: bool = False
    names: list[tuple[str, str]] = field(default_factory=list)
    strings_cut: int = 0
    characters_removed: int = 0


class _TooLarge(Exception):
    pass


def looks_secret(name: str, value: object) -> bool:
    if type(value) not in (str, int, float) or type(value) is bool:
        return False
    if type(value) is str and (
        not value
        or value == REDACTED
        or value.strip().lower()
        in ("true", "false", "none", "basic", "bearer", "oauth", "required", "optional")
    ):
        return False
    name = re.sub("v?[0-9]+$", "", fold(name))
    terms = [
        "token",
        "secret",
        "password",
        "passwd",
        "passphrase",
        "passcode",
        "credential",
        "credentials",
        "authorization",
        "auth",
        "bearer",
        "cookie",
        "cookies",
        "signature",
        "jwt",
        "otp",
        "cvv",
        "cvc",
        "apikey",
        "accesskey",
        "secretkey",
        "privatekey",
        "signingkey",
        "encryptionkey",
        "masterkey",
        "sessionkey",
        "authkey",
        "hmackey",
        "sharedkey",
        "subscriptionkey",
        "sessionid",
        "sessid",
        "secretstring",
        "secretvalue",
        "codeverifier",
        "clientassertion",
        "authcode",
        "authorizationcode",
        "otpcode",
        "mfacode",
        "recoverycode",
        "connectionstring",
        "databaseurl",
        "dsn",
        "passwordconfirmation",
    ]
    for term in terms:
        if not name.endswith(term):
            continue
        prefix = name[: -len(term)]
        if term == "token" and prefix.endswith(
            tuple(
                [
                    "page",
                    "next",
                    "continuation",
                    "pagination",
                    "sync",
                    "client",
                    "clientrequest",
                    "idempotency",
                    "resume",
                    "cancel",
                    "cursor",
                    "start",
                    "stop",
                    "bos",
                    "eos",
                    "pad",
                    "unk",
                    "sep",
                    "cls",
                    "mask",
                ]
            )
        ):
            return False
        if term == "signature" and prefix.endswith("email"):
            return False
        if term == "auth" and type(value) is str and (len(value) < 8):
            return False
        return True
    return (
        name == "hmac"
        or name
        in ("pin",)
        + tuple(
            x + "pin"
            for x in [
                "card",
                "atm",
                "user",
                "account",
                "security",
                "login",
                "new",
                "old",
                "current",
            ]
        )
        or name in tuple(x + "pwd" for x in ["db", "user", "admin", "root", "database"])
    )


def capture(value: object, config: Config, *, field_name: str = "input") -> Captured:
    result = Captured(None)
    any_depth = set(SECRETS)
    paths = []
    if config.capture_mode != "full-payload":
        for rule in config.redact:
            if rule.startswith("**.") and (not any(c in rule[3:] for c in ".*[]")):
                any_depth.add(fold(rule[3:]))
            else:
                paths.append(
                    tuple(fold(x) for x in rule.replace("[*]", ".[*]").split("."))
                )
    known = set(config.known_safe_names)
    ancestors = set()
    visited = 0
    budget = 0

    def matches(path):
        return any(
            len(rule) == len(path)
            and all((r == "*" or r == fold(p) for r, p in zip(rule, path)))
            for rule in paths
        )

    def observe(name, child, path):
        if (
            fold(name) not in known
            and looks_secret(name, child)
            and (len(result.names) < MAX_SECRET_NAMES)
        ):
            result.names.append(
                (
                    name[:MAX_SECRET_NAME_LENGTH],
                    ".".join(path).replace(".[*]", "[*]")[:MAX_SECRET_PATH_LENGTH],
                )
            )

    def text(value):
        fixed = repair_text(value)
        if "\r\n" in fixed or re.search(
            "\\[TRUNCATED: [0-9]+ characters removed\\]$", fixed
        ):
            lines = fixed.split("\r\n")
            done = False
            for i, line in enumerate(lines):
                if not line and i > 0:
                    done = True
                if done:
                    continue
                match = re.match("^([!#$%&'*+.^_`|~0-9A-Za-z-]+):([ \\t]*)(.*)$", line)
                if match:
                    name, space, child = match.groups()
                    if child and fold(name) in any_depth:
                        lines[i] = name + ":" + space + REDACTED
                    elif child:
                        observe(name, child, ())
            fixed = "\r\n".join(lines)
        cut = truncate_text(fixed)
        if cut != fixed:
            result.truncated = True
            result.strings_cut += 1
            removed = re.search("\\[TRUNCATED: ([0-9]+) characters removed\\]$", cut)
            if removed:
                result.characters_removed += int(removed[1])
        return cut

    def walk(value, depth, path):
        nonlocal visited, budget
        visited += 1
        if visited > config.max_event_bytes or depth > 30:
            raise _TooLarge()
        if value is UNSET:
            out = None
        elif value is None or type(value) is bool:
            out = value
        elif type(value) is str:
            out = text(value)
        elif type(value) is int:
            out = value if abs(value) <= 9007199254740991 else str(Decimal(value))
            # A decimal repair must retain every digit. Truncating it would
            # invent a different numeric value, so omit an over-limit payload.
            if type(out) is str and len(out) > 65536:
                raise _TooLarge()
        elif type(value) is float:
            out = value if math.isfinite(value) else None
        elif type(value) in (bytes, bytearray):
            if len(value) > config.max_event_bytes:
                raise _TooLarge()
            # The rendered object occupies this depth, and its strings occupy
            # the next. Apply the same limits to the representation we send.
            return walk(
                {"type": "bytes", "base64": base64.b64encode(value).decode("ascii")},
                depth,
                path,
            )
        elif type(value) in (dt.datetime, dt.date):
            if type(value) is dt.date:
                value = dt.datetime.combine(value, dt.time(), dt.timezone.utc)
            if value.tzinfo is None:
                value = value.replace(tzinfo=dt.timezone.utc)
            out = (
                value.astimezone(dt.timezone.utc)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
        elif isinstance(value, Mapping) or type(value) in (tuple, list):
            if id(value) in ancestors:
                return "[CIRCULAR]"
            ancestors.add(id(value))
            try:
                if len(value) > 1000:
                    raise _TooLarge()
                if isinstance(value, Mapping):
                    out = {}
                    for index, key in enumerate(value):
                        if index >= 1000:
                            raise _TooLarge()
                        if type(key) is not str:
                            result.unreadable = True
                            continue
                        fixed = repair_text(key)
                        newpath = path + (key,)
                        if fold(key) in any_depth or matches(newpath):
                            out[fixed] = REDACTED
                            continue
                        try:
                            child = value[key]
                        except Exception:
                            child = UNCAPTURABLE
                            result.unreadable = True
                        if child is UNSET:
                            continue
                        observe(key, child, newpath)
                        out[fixed] = walk(child, depth + 1, newpath)
                        budget += len(fixed.encode("utf-8"))
                        if budget > config.max_event_bytes:
                            raise _TooLarge()
                else:
                    interleaved = (
                        len(value) > 0
                        and len(value) % 2 == 0
                        and all(type(x) is str for x in value)
                        and all(TOKEN.fullmatch(x) for x in value[::2])
                        and any(x.lower() in KNOWN_HEADERS for x in value[::2])
                    )
                    out = []
                    for index, child in enumerate(value):
                        subpath = path + ("[*]",)
                        if matches(subpath):
                            out.append(REDACTED)
                            continue
                        if interleaved and index % 2:
                            name = value[index - 1]
                            if (
                                fold(name) in any_depth
                                and child.lower() not in KNOWN_HEADERS
                            ):
                                out.append(REDACTED)
                                continue
                            if fold(name) not in any_depth:
                                observe(name, child, subpath)
                        elif (
                            type(child) in (list, tuple)
                            and len(child) == 2
                            and (type(child[0]) is str)
                        ):
                            name, val = child
                            if fold(name) in any_depth and not (
                                type(val) is str and val.lower() in KNOWN_HEADERS
                            ):
                                out.append([repair_text(name), REDACTED])
                                continue
                            if fold(name) not in any_depth:
                                observe(name, val, subpath)
                        elif type(child) is dict and "value" in child:
                            name = child.get("name")
                            if type(name) is not str:
                                name = child.get("key")
                            if type(name) is str:
                                val = child["value"]
                                if fold(name) in any_depth and not (
                                    type(val) is str and val.lower() in KNOWN_HEADERS
                                ):
                                    child = {**child, "value": REDACTED}
                                elif fold(name) not in any_depth:
                                    observe(name, val, subpath)
                        out.append(walk(child, depth + 1, subpath))
            except _TooLarge:
                raise
            except Exception:
                out = UNCAPTURABLE
                result.unreadable = True
            finally:
                ancestors.remove(id(value))
        else:
            out = UNCAPTURABLE
            result.unreadable = True
        budget += len(out.encode("utf-8")) + 2 if type(out) is str else 1
        if budget > config.max_event_bytes:
            raise _TooLarge()
        return out

    try:
        result.value = walk(value, 0, ())
    except _TooLarge:
        result.value = TOO_LARGE
        result.omitted = True
        result.truncated = False
        result.names = []
    except Exception:
        result.value = UNCAPTURABLE
        result.unreadable = True
        result.truncated = False
        result.names = []
    return result
