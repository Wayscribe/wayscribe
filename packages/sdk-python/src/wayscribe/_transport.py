"""Single-owner, bounded delivery. No host callbacks run under the state lock."""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import random
import select
import socket
import ssl
import threading
import time
from collections import deque
from dataclasses import dataclass
from urllib.parse import urlsplit

from ._config import Config
from ._diagnostics import Diagnostics

_RESPONSE_LIMIT = 1048576


@dataclass(eq=False)
class _Pending:
    body: bytes
    sequence: int
    refused_at: float | None = None
    refused_sends: int = 0


class _Cancelled(Exception):
    pass


class _GuardedSend:
    # http.client must never reconnect implicitly after cancellation closed a
    # socket. All HTTP header/body writes pass the same cancellation gate.
    auto_open = 0

    def send(self, data):
        self._write(self, data)


class _HTTPConnection(_GuardedSend, http.client.HTTPConnection):
    pass


class _HTTPSConnection(_GuardedSend, http.client.HTTPSConnection):
    pass


class Transport:
    def __init__(
        self,
        config: Config,
        diagnostics: Diagnostics,
        *,
        clock=time.monotonic,
        jitter=random.random,
        wait=None,
    ):
        self.config = config
        self.diagnostics = diagnostics
        self._pid = os.getpid()
        self._clock = clock
        self._jitter = jitter
        self._wait = wait or (lambda condition, delay: condition.wait(delay))
        self._condition = threading.Condition(threading.Lock())
        self._queue = deque()
        self._inflight = []
        self._sequence = 0
        self._closing = False
        self._cancelled = False
        self._finished = False
        self._result = True
        self._flushers = 0
        self._socket = None
        self._failures = 0
        self._opened_until = 0.0
        self._next_send = self._clock() + config.flush_interval_ms / 1000
        self._thread = None
        if config.enabled:
            self._thread = threading.Thread(
                target=self._run, name="wayscribe-sender", daemon=True
            )
            self._thread.start()

    def local(self):
        return os.getpid() == self._pid

    def enqueue(self, body: bytes):
        if not self.local():
            return
        cause = None
        with self._condition:
            self.diagnostics.increment("recorded")
            if self._closing or self._finished:
                cause = "after_shutdown"
            else:
                self._sequence += 1
                if len(self._queue) >= self.config.max_buffered_events:
                    self._queue.popleft()
                    cause = "queue_full"
                self._queue.append(_Pending(body, self._sequence))
                self._condition.notify_all()
            if cause:
                self.diagnostics.increment("dropped", cause=cause)
        if cause:
            self.diagnostics.emit("dropped", code=cause)

    def flush(self, timeout_ms=5000):
        if not self.local():
            return False
        deadline = time.monotonic() + _timeout(timeout_ms)
        with self._condition:
            if self._finished:
                return self._result
            # A diagnostic may reenter from this worker; it cannot wait on itself.
            if threading.current_thread() is self._thread:
                return not self._queue and not self._inflight
            self._flushers += 1
            self._condition.notify_all()
            try:
                while self._queue or self._inflight:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or self._finished:
                        return self._result if self._finished else False
                    self._condition.wait(remaining)
                return True
            finally:
                self._flushers -= 1

    def shutdown(self, timeout_ms=5000):
        if not self.local():
            return False
        deadline = time.monotonic() + _timeout(timeout_ms)
        with self._condition:
            if self._finished:
                return self._result
            self._closing = True
            self._condition.notify_all()
            while self._queue or self._inflight:
                remaining = deadline - time.monotonic()
                if (
                    remaining <= 0
                    or self._finished
                    or threading.current_thread() is self._thread
                ):
                    break
                self._condition.wait(remaining)
            sock = self._finalize_locked()
            result = self._result
        _abort(sock)
        return result

    async def async_flush(self, timeout_ms=5000):
        return await self._async_lifecycle(False, timeout_ms)

    async def async_shutdown(self, timeout_ms=5000):
        return await self._async_lifecycle(True, timeout_ms)

    async def _async_lifecycle(self, closing, timeout_ms):
        if not self.local():
            return False
        deadline = time.monotonic() + _timeout(timeout_ms)
        # No executor threads: the sole daemon sender owns network work, and
        # bounded async polling cannot keep the host alive at interpreter exit.
        try:
            with self._condition:
                if closing:
                    self._closing = True
                self._flushers += 1
                self._condition.notify_all()
            while True:
                with self._condition:
                    ready = self._finished or not (self._queue or self._inflight)
                if ready or time.monotonic() >= deadline:
                    return self.shutdown(0) if closing else self.flush(0)
                await asyncio.sleep(min(0.01, max(0, deadline - time.monotonic())))
        finally:
            with self._condition:
                self._flushers -= 1
            if closing:
                self.shutdown(0)

    def _finalize_locked(self):
        if self._finished:
            return None
        lost = len(self._queue) + len(self._inflight)
        self.diagnostics.increment("dropped", lost, cause="shutdown")
        self._queue.clear()
        self._inflight.clear()
        self._result = lost == 0
        self._finished = self._cancelled = True
        sock, self._socket = self._socket, None
        self._condition.notify_all()
        return sock

    def _run(self):
        try:
            while True:
                with self._condition:
                    while True:
                        if self._cancelled:
                            return
                        now = self._clock()
                        if self._closing and not self._queue:
                            self._finalize_locked()
                            return
                        delay = max(0.0, self._opened_until - now)
                        if self._closing and delay:
                            self._finalize_locked()
                            return
                        ready = (
                            self._closing
                            or self._flushers
                            or len(self._queue) >= self.config.batch_size
                            or now >= self._next_send
                        )
                        if self._queue and ready and not delay:
                            if self._opened_until:
                                self._opened_until = 0
                                self._failures = 0
                            batch = [
                                self._queue.popleft()
                                for _ in range(
                                    min(len(self._queue), self.config.batch_size)
                                )
                            ]
                            self._inflight = batch.copy()
                            break
                        if not self._queue:
                            self._wait(self._condition, None)
                        else:
                            self._wait(
                                self._condition,
                                delay or max(0.001, self._next_send - now),
                            )
                self._send_cycle(batch)
        except BaseException:
            # Internal failures remain inside the daemon boundary. Give every
            # admitted event one final outcome, rather than strand flush callers.
            with self._condition:
                sock = self._finalize_locked()
            _abort(sock)

    def _settle_locked(self, item, outcome, cause=None):
        if item in self._inflight:
            self._inflight.remove(item)
            self.diagnostics.increment(outcome, cause=cause)

    def _send_cycle(self, batch):
        stored = False
        answered = False
        permanent_request = False
        refused = set()
        initial = len(batch)
        abandoned = False
        for attempt in range(self.config.max_attempts):
            if attempt and not self._backoff(attempt):
                return
            with self._condition:
                if self._cancelled:
                    return
                now = self._clock()
                for item in self._inflight.copy():
                    if (
                        item.refused_at is not None
                        and now - item.refused_at
                        >= self.config.event_retry_budget_ms / 1000
                    ):
                        abandoned = True
                        self._settle_locked(item, "dropped", "retry_budget")
                pending = self._inflight.copy()
                if not pending:
                    break
            body = b'{"events":[' + b",".join(x.body for x in pending) + b"]}"
            try:
                status, response = self._request(body)
            except _Cancelled:
                return
            except Exception:
                status, response = 0, b""
            with self._condition:
                if self._cancelled:
                    return
                if 400 <= status < 500:
                    permanent_request = True
                    for item in pending:
                        self._settle_locked(item, "rejected")
                elif 200 <= status < 400:
                    results = _results(response) if status < 300 else []
                    for index, item in enumerate(pending):
                        # Position is authoritative; response event IDs are
                        # supplemental and must never reorder queue ownership.
                        verdict = results[index] if index < len(results) else None
                        outcome, transient = _verdict(verdict)
                        if outcome == "sent":
                            stored = answered = True
                            self._settle_locked(item, "sent")
                        elif outcome == "rejected":
                            answered = True
                            if transient:
                                if item.refused_at is None:
                                    item.refused_at = self._clock()
                                refused.add(item)
                            else:
                                self._settle_locked(item, "rejected")
                        else:
                            self._settle_locked(item, "dropped", "no_verdict")
                if not self._inflight or permanent_request:
                    break
        with self._condition:
            if self._cancelled:
                return
            for item in self._inflight.copy():
                if item in refused:
                    item.refused_sends += 1
                    if (
                        item.refused_sends >= self.config.event_retry_max_sends
                        or self._clock() - item.refused_at
                        >= self.config.event_retry_budget_ms / 1000
                    ):
                        abandoned = True
                        self._settle_locked(item, "dropped", "retry_budget")
            unresolved = bool(self._inflight)
            opened = False
            if stored:
                self._failures = 0
            elif not permanent_request:
                if answered and not unresolved and not abandoned:
                    self._failures = 0
                else:
                    self._failures += 1
                    if self._failures >= self.config.breaker_threshold:
                        self._opened_until = (
                            self._clock() + self.config.breaker_reset_ms / 1000
                        )
                        opened = True
            progress = initial - len(self._inflight)
            # Retry identities keep their original age for oldest-first eviction.
            queued = sorted([*self._inflight, *self._queue], key=lambda x: x.sequence)
            self._inflight = []
            overflow = max(0, len(queued) - self.config.max_buffered_events)
            self.diagnostics.increment("dropped", overflow, cause="queue_full")
            self._queue = deque(queued[overflow:])
            self._next_send = self._clock() + self.config.flush_interval_ms / 1000
            if self._closing and unresolved and not progress:
                self._finalize_locked()
            self._condition.notify_all()
        if opened:
            self.diagnostics.emit("breaker_open", code="consecutive_failures")
        if unresolved:
            self.diagnostics.emit("transport_error", code="request_failed")

    def _backoff(self, attempt):
        delay = (
            self._jitter()
            * min(
                self.config.backoff_base_ms * 2 ** (attempt - 1),
                self.config.backoff_max_ms,
            )
            / 1000
        )
        with self._condition:
            until = self._clock() + delay
            while not self._cancelled and self._clock() < until:
                self._wait(self._condition, until - self._clock())
            return not self._cancelled

    def _request(self, body):
        url = urlsplit(self.config.endpoint)
        connection_type = _HTTPSConnection if url.scheme == "https" else _HTTPConnection
        connection = connection_type(
            url.hostname, url.port, timeout=self.config.request_timeout_ms / 1000
        )
        connection._write = self._write
        deadline = time.monotonic() + self.config.request_timeout_ms / 1000
        connection._deadline = deadline
        response = None
        try:
            with self._condition:
                if self._cancelled:
                    raise _Cancelled()
            # DNS/connect/TLS can finish after shutdown; they are never allowed
            # to progress to an HTTP write without checking the gate again.
            connection.connect()
            with self._condition:
                if self._cancelled:
                    raise _Cancelled()
                self._socket = connection.sock
                connection.sock.setblocking(False)
            connection.request(
                "POST",
                url.path.rstrip("/") + "/v1/events/batch",
                body,
                {
                    "Authorization": "Bearer " + self.config.api_key,
                    "Content-Type": "application/json",
                },
            )
            with self._condition:
                if self._cancelled:
                    raise _Cancelled()
                connection.sock.settimeout(max(0.001, deadline - time.monotonic()))
            response = connection.getresponse()
            try:
                result = bytearray()
                while len(result) <= _RESPONSE_LIMIT and not response.isclosed():
                    with self._condition:
                        if self._cancelled:
                            raise _Cancelled()
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError()
                        if self._socket:
                            self._socket.settimeout(remaining)
                    part = response.read1(min(65536, _RESPONSE_LIMIT + 1 - len(result)))
                    if not part:
                        break
                    result.extend(part)
                return response.status, bytes(result) if len(
                    result
                ) <= _RESPONSE_LIMIT else b""
            except (OSError, http.client.HTTPException):
                # Once status is known, a missing body cannot turn a permanent
                # 4xx or a successful request with no verdict into a resend.
                return response.status, b""
        finally:
            with self._condition:
                self._socket = None
            if response is not None:
                response.close()
            connection.close()

    def _write(self, connection, data):
        view = memoryview(data)
        while view:
            with self._condition:
                if self._cancelled or connection.sock is None:
                    raise _Cancelled()
                remaining = connection._deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                sock = connection.sock
                try:
                    written = sock.send(view[:65536])
                    if written == 0:
                        raise OSError("connection closed")
                    view = view[written:]
                    continue
                except (BlockingIOError, ssl.SSLWantWriteError):
                    readable = False
                except ssl.SSLWantReadError:
                    readable = True
            select.select(
                [sock] if readable else [],
                [] if readable else [sock],
                [],
                min(remaining, 0.05),
            )


def _timeout(value):
    return (
        value / 1000
        if type(value) in (int, float) and 0 <= value <= 2147483647
        else 5.0
    )


def _abort(sock):
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass


def _invalid_json_constant(value):
    raise ValueError()


def _results(body):
    try:
        result = json.loads(body, parse_constant=_invalid_json_constant)["data"][
            "results"
        ]
        return result if type(result) is list else []
    except (ValueError, TypeError, KeyError, RecursionError):
        return []


def _verdict(value):
    if type(value) is not dict:
        return None, False
    if value.get("status") == "accepted":
        return "sent", False
    if value.get("status") == "rejected":
        error = value.get("error")
        status = error.get("httpStatus") if type(error) is dict else None
        return "rejected", type(status) in (int, float) and status >= 500
    return None, False
