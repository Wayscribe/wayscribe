"""Explicit timing evidence. Inputs are mappings or objects with snake_case fields."""

from __future__ import annotations

import datetime as dt
import json
import re
import time
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

MAX_MS = 2147483647
SAFE = 9007199254740991
_MISSING = object()


def _read(source, key, default=None):
    try:
        return (
            source.get(key, default)
            if isinstance(source, Mapping)
            else getattr(source, key, default)
        )
    except Exception:
        return None


def _integer(value, minimum=0, maximum=SAFE):
    return value if type(value) is int and minimum <= value <= maximum else None


def _identity(value):
    if type(value) is not str or not 1 <= len(value) <= 256:
        return None
    if value in (
        "[REDACTED]",
        "[UNCAPTURABLE]",
        "[PAYLOAD_TOO_LARGE]",
        "[CIRCULAR]",
    ) or re.search("\\[TRUNCATED: [0-9]+ characters removed\\]$", value):
        return None
    if "\x00" in value or any(55296 <= ord(c) <= 57343 for c in value):
        return None
    return value


def queue_metadata(
    job: object, *, ready_again_at: int | None = None, delivery_count: int | None = None
) -> dict[str, Any]:
    result = {}
    queue = _identity(_read(job, "queue_name"))
    identifier = _identity(_read(job, "id"))
    delivery = _integer(delivery_count, 1)
    made = _integer(_read(job, "attempts_made"), 0, SAFE - 1)
    attempt = made + 1 if made is not None else None
    if queue is not None:
        result["queue"] = queue
    if delivery is not None:
        result["deliveryCount"] = delivery
    if attempt is not None:
        result["attempt"] = attempt
    if queue is not None and identifier is not None:
        group = "queue:" + json.dumps(
            [queue, identifier], ensure_ascii=False, separators=(",", ":")
        )
        if len(group) <= 256:
            result["retryGroup"] = group
    processed = _integer(_read(job, "processed_on"))
    earlier = None
    basis = None
    if attempt == 1 and (delivery is None or delivery == 1):
        earlier = _integer(_read(job, "timestamp"))
        basis = "initial-enqueue"
    elif attempt is not None and attempt > 1:
        earlier = _integer(ready_again_at)
        basis = "retry-ready"
    if processed is not None and earlier is not None:
        elapsed = _integer(processed - earlier, 0, MAX_MS)
        if elapsed is not None:
            result.update(queueWaitMs=elapsed, queueWaitBasis=basis)
    return result


_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


def _http_date(text, now):
    patterns = (
        (
            "^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ([A-Z][a-z]{2}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$",
            0,
        ),
        (
            "^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-([A-Z][a-z]{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$",
            1,
        ),
        (
            "^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\\d{2}| \\d) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$",
            2,
        ),
    )
    try:
        for pattern, kind in patterns:
            match = re.fullmatch(pattern, text, re.ASCII)
            if not match:
                continue
            if kind == 2:
                weekday, month, day, hour, minute, second, year = match.groups()
            else:
                weekday, day, month, year, hour, minute, second = match.groups()
            month = _MONTHS.index(month) + 1
            day = int(day)
            year = int(year)
            hour = int(hour)
            minute = int(minute)
            second = int(second)
            if kind == 1:
                observation = dt.datetime.fromtimestamp(now / 1000, dt.timezone.utc)
                cutoff_year = observation.year + 50
                year = cutoff_year // 100 * 100 + year
                if (year, month, day, hour, minute, second) > (
                    cutoff_year,
                    observation.month,
                    observation.day,
                    observation.hour,
                    observation.minute,
                    observation.second,
                ):
                    year -= 100
            if second > 60:
                return None
            date = dt.datetime(
                year, month, day, hour, minute, min(second, 59), tzinfo=dt.timezone.utc
            )
            if _WEEKDAYS[date.weekday()] != weekday[:3]:
                return None
            return int(date.timestamp() * 1000) + (1000 if second == 60 else 0)
    except (ValueError, OverflowError, OSError):
        pass
    return None


def http_metadata(
    response: object, *, target_url: str | None = None, now: object = _MISSING
) -> dict[str, Any]:
    result = {}
    try:
        if type(target_url) is str:
            parsed = urlsplit(target_url)
            if (
                parsed.scheme in ("http", "https")
                and parsed.hostname
                and (not any(ord(c) <= 32 for c in target_url))
            ):
                host = parsed.hostname.encode("idna").decode("ascii").lower()
                if ":" in host:
                    host = "[" + host + "]"
                port = parsed.port
                if (
                    port is not None
                    and port != {"http": 80, "https": 443}[parsed.scheme]
                ):
                    host += ":" + str(port)
                host = _identity(host)
                if host is not None:
                    result["targetHost"] = host
    except Exception:
        pass
    status = _integer(_read(response, "status"), 100, 599)
    if status is not None:
        result["httpStatusCode"] = status
    try:
        headers = _read(response, "headers")
        if isinstance(headers, Mapping):
            retry = next(
                (
                    value
                    for key, value in headers.items()
                    if type(key) is str and key.lower() == "retry-after"
                ),
                None,
            )
        else:
            retry = headers.get("retry-after")
        if type(retry) is not str:
            return result
        retry = retry.strip()
        if re.fullmatch("[0-9]+", retry):
            if len(retry) > 10:
                return result
            wait = _integer(int(retry) * 1000, 0, MAX_MS)
        else:
            observed = int(time.time() * 1000) if now is _MISSING else _integer(now)
            if observed is None:
                return result
            date = _http_date(retry, observed)
            wait = _integer(date - observed, 0, MAX_MS) if date is not None else None
        if wait is not None:
            result["retryAfterMs"] = wait
    except Exception:
        pass
    return result
