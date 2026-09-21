import json
import threading
import unittest

import wayscribe
from delivery_helpers import Collector, accepted


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            callable(getattr(wayscribe, "create_recorder", None)),
            "public recorder facade is missing",
        )

    def record(self, recorder, count=1):
        journey = recorder.journey({"type": "order", "id": "42"})
        for index in range(count):
            journey.record(
                operation="received",
                name=str(index),
                input={"password": "secret", "index": index},
            )

    def test_batch_route_headers_limits_and_detached_counters(self):
        with Collector() as server:
            recorder = server.recorder(batch_size=100, flush_interval_ms=60000)
            self.record(recorder, 101)
            self.assertTrue(recorder.shutdown())
            self.assertEqual(
                [len(json.loads(b)["events"]) for b in server.bodies], [100, 1]
            )
            self.assertEqual(server.paths, ["/v1/events/batch"] * 2)
            self.assertEqual(server.headers[0]["Authorization"], "Bearer test-key")
            self.assertNotIn(b'"secret"', b"".join(server.bodies))
            counts = recorder.counters()
            self.assertEqual(counts["recorded"], 101)
            self.assertEqual(counts["sent"], 101)
            counts["sent"] = 0
            counts["dropped_by_cause"]["shutdown"] = 100
            self.assertEqual(recorder.counters()["sent"], 101)
            self.assertEqual(recorder.counters()["dropped"], 0)

    def test_partial_verdict_retries_only_transient_with_identical_bytes(self):
        def respond(body, index):
            if index:
                return accepted(body)
            ids = [e["event"]["id"] for e in json.loads(body)["events"]]
            return 202, {
                "data": {
                    "results": [
                        {"eventId": ids[0], "status": "accepted", "duplicate": True},
                        {
                            "eventId": ids[1],
                            "status": "rejected",
                            "error": {"httpStatus": 409},
                        },
                        {
                            "eventId": ids[2],
                            "status": "rejected",
                            "error": {"httpStatus": 503},
                        },
                    ]
                }
            }

        with Collector(respond) as server:
            recorder = server.recorder(flush_interval_ms=60000)
            self.record(recorder, 3)
            self.assertTrue(recorder.shutdown())
            counts = recorder.counters()
            self.assertEqual(
                (counts["sent"], counts["rejected"], counts["dropped"]), (2, 1, 0)
            )
            first = json.loads(server.bodies[0])["events"][2]
            self.assertEqual(json.loads(server.bodies[1])["events"], [first])
            serialized = json.dumps(
                first, ensure_ascii=False, separators=(",", ":")
            ).encode()
            self.assertIn(serialized, server.bodies[0])
            self.assertEqual(server.bodies[1], b'{"events":[' + serialized + b"]}")

    def test_no_verdict_and_permanent_outcomes_are_not_retried(self):
        responses = [
            (202, b"not json"),
            (202, b'{"data":{"results":[{"status":"accepted"}]},"invalid":NaN}'),
            (202, {}),
            (202, {"data": {"results": []}}),
            (202, {"data": {"results": [{"status": "unknown"}]}}),
            (202, b"x" * 1048577),
            (302, b""),
            (400, b""),
            (401, b""),
            (429, b""),
            (
                202,
                {
                    "data": {
                        "results": [
                            {"status": "rejected", "error": {"code": "unknown"}}
                        ]
                    }
                },
            ),
        ]
        for response in responses:
            with self.subTest(status=response[0], body_type=type(response[1]).__name__):
                with Collector(lambda body, index: response) as server:
                    recorder = server.recorder()
                    self.record(recorder)
                    self.assertTrue(recorder.shutdown())
                    self.assertEqual(len(server.bodies), 1)
                    counts = recorder.counters()
                    self.assertEqual(counts["sent"], 0)
                    permanent = response[0] >= 400 or response is responses[-1]
                    self.assertEqual(counts["rejected"], int(permanent))
                    self.assertEqual(
                        counts["dropped_by_cause"]["no_verdict"], int(not permanent)
                    )

    def test_whole_request_retry_is_byte_identical(self):
        with Collector(
            lambda body, index: (503, b"") if index < 2 else accepted(body)
        ) as server:
            recorder = server.recorder()
            self.record(recorder)
            self.assertTrue(recorder.shutdown())
            self.assertEqual(len(server.bodies), 3)
            self.assertEqual(server.bodies[0], server.bodies[1])
            self.assertEqual(server.bodies[0], server.bodies[2])
            self.assertEqual(recorder.counters()["sent"], 1)

    def test_oldest_pending_eviction_during_one_blocked_send(self):
        release = threading.Event()

        def respond(body, index):
            release.wait(3)
            return accepted(body)

        with Collector(respond) as server:
            recorder = server.recorder(batch_size=1, max_buffered_events=2)
            self.addCleanup(release.set)
            self.addCleanup(recorder.shutdown, 1)
            self.record(recorder)
            self.assertTrue(server.received.wait(2))
            journey = recorder.journey({"type": "x", "id": "1"})
            for name in ("old", "new", "newest"):
                journey.record(operation="received", name=name)
            self.assertEqual(recorder.counters()["dropped_by_cause"]["queue_full"], 1)
            release.set()
            self.assertTrue(recorder.shutdown())
            self.assertEqual(
                [e["name"] for e in server.events()], ["0", "new", "newest"]
            )

    def test_unexpected_event_ids_cannot_reorder_positional_verdicts(self):
        def respond(body, index):
            ids = [e["event"]["id"] for e in json.loads(body)["events"]]
            return 202, {
                "data": {
                    "results": [
                        {"status": "accepted", "eventId": "evt_unknown"},
                        {
                            "status": "rejected",
                            "eventId": ids[0],
                            "error": {"httpStatus": 400},
                        },
                    ]
                }
            }

        with Collector(respond) as server:
            recorder = server.recorder(flush_interval_ms=60000)
            self.record(recorder, 2)
            self.assertTrue(recorder.shutdown())
            self.assertEqual(recorder.counters()["sent"], 1)
            self.assertEqual(recorder.counters()["rejected"], 1)
            self.assertEqual(len(server.bodies), 1)

    def test_body_timeout_does_not_retry_known_4xx_or_success_without_verdict(self):
        for status in (401, 202):
            with self.subTest(status=status):
                release = threading.Event()
                with Collector(
                    lambda body, index: (status, b"{}"),
                    before_body=lambda: release.wait(2),
                ) as server:
                    recorder = server.recorder(request_timeout_ms=10)
                    self.record(recorder)
                    self.assertTrue(recorder.shutdown(1000))
                    release.set()
                    self.assertEqual(len(server.bodies), 1)
                    counts = recorder.counters()
                    self.assertEqual(counts["rejected"], int(status == 401))
                    self.assertEqual(
                        counts["dropped_by_cause"]["no_verdict"], int(status == 202)
                    )


class RetryBudgetTests(unittest.TestCase):
    def make_recorder(self, server, *, clock=None, **internal):
        from dataclasses import replace
        from unittest.mock import patch

        from wayscribe._transport import Transport

        self.clock = clock or [0.0]

        def factory(config, diagnostics):
            return Transport(
                replace(config, **internal),
                diagnostics,
                clock=lambda: self.clock[0],
                jitter=lambda: 0,
            )

        with patch("wayscribe.recorder.Transport", factory):
            recorder = server.recorder(batch_size=1, flush_interval_ms=1000)
        self.addCleanup(recorder.shutdown, 0)
        return recorder

    def record(self, recorder):
        recorder.journey({"type": "x", "id": "1"}).complete()

    def test_transient_budget_is_ten_sends_of_three_attempts(self):
        def refuse(body, index):
            return 202, {
                "data": {
                    "results": [{"status": "rejected", "error": {"httpStatus": 503}}]
                }
            }

        with Collector(refuse) as server:
            # Isolate the send cap from the independent breaker cooldown.
            recorder = self.make_recorder(server, breaker_threshold=100)
            self.record(recorder)
            self.assertTrue(recorder.flush(1000))
            self.assertEqual(len(server.bodies), 30)
            self.assertEqual(len(set(server.bodies)), 1)
            self.assertEqual(recorder.counters()["dropped_by_cause"]["retry_budget"], 1)
            self.assertTrue(recorder.shutdown())

    def test_transient_budget_expires_thirty_seconds_after_first_refusal(self):
        clock = [0.0]

        def refuse(body, index):
            if index == 1:
                clock[0] = 30.0
            return 202, {
                "data": {
                    "results": [{"status": "rejected", "error": {"httpStatus": 503}}]
                }
            }

        with Collector(refuse) as server:
            recorder = self.make_recorder(server, clock=clock)
            self.record(recorder)
            self.assertTrue(recorder.flush(1000))
            self.assertEqual(len(server.bodies), 2)
            self.assertEqual(recorder.counters()["dropped_by_cause"]["retry_budget"], 1)

    def test_transport_only_cycles_count_once_toward_refused_send_cap(self):
        from dataclasses import replace

        from wayscribe._config import Config
        from wayscribe._diagnostics import Diagnostics
        from wayscribe._transport import Transport, _Pending

        diagnostics = Diagnostics()
        transport = Transport(
            replace(
                Config(False, "http://127.0.0.1", "key", "test", "development"),
                max_attempts=2,
                event_retry_max_sends=2,
                breaker_threshold=100,
            ),
            diagnostics,
            clock=lambda: 0.0,
            jitter=lambda: 0,
        )
        entry = _Pending(b'{"event":{"id":"evt_1"}}', 1)
        refusal = json.dumps(
            {
                "data": {
                    "results": [
                        {"status": "rejected", "error": {"httpStatus": 503}}
                    ]
                }
            }
        ).encode()
        responses = [(202, refusal), (503, b""), (503, b""), (503, b"")]
        bodies = []

        def request(body):
            bodies.append(body)
            return responses.pop(0)

        transport._request = request
        transport._inflight = [entry]
        diagnostics.increment("recorded")
        transport._send_cycle([entry])
        self.assertEqual(entry.refused_sends, 1)
        self.assertEqual(diagnostics.counters()["dropped_by_cause"]["retry_budget"], 0)

        transport._inflight = [transport._queue.popleft()]
        transport._send_cycle([entry])
        self.assertEqual(len(bodies), 4)
        self.assertEqual(len(set(bodies)), 1)
        self.assertEqual(diagnostics.counters()["dropped_by_cause"]["retry_budget"], 1)
        self.assertEqual(list(transport._queue), [])

    def test_wrong_body_opens_breaker_until_cooldown_then_acceptance_resets_it(self):
        mode = ["bad"]
        with Collector(
            lambda body, index: (202, b"bad") if mode[0] == "bad" else accepted(body)
        ) as server:
            recorder = self.make_recorder(server)
            for _ in range(5):
                self.record(recorder)
                self.assertTrue(recorder.flush(1000))
            self.record(recorder)
            self.assertFalse(recorder.flush(20))
            self.assertEqual(len(server.bodies), 5)
            mode[0] = "good"
            with recorder._transport._condition:
                self.clock[0] = 30.0
                recorder._transport._condition.notify_all()
            self.assertTrue(recorder.flush(1000))
            self.assertEqual(recorder.counters()["sent"], 1)
            mode[0] = "bad"
            for _ in range(4):
                self.record(recorder)
                self.assertTrue(recorder.flush(1000))
            mode[0] = "good"
            self.record(recorder)
            self.assertTrue(recorder.shutdown())
            self.assertEqual(recorder.counters()["sent"], 2)

    def test_whole_request_4xx_neither_resets_nor_increments_breaker(self):
        with Collector(
            lambda body, index: (401, b"") if index == 3 else (202, b"bad")
        ) as server:
            recorder = self.make_recorder(server)
            for _ in range(6):
                self.record(recorder)
                self.assertTrue(recorder.flush(1000))
            self.record(recorder)
            self.assertFalse(recorder.flush(20))
            self.assertEqual(len(server.bodies), 6)
            self.assertEqual(recorder.counters()["rejected"], 1)

    def test_refusals_exhausting_budget_still_count_as_breaker_failure(self):
        def refused(body, index):
            return 202, {
                "data": {
                    "results": [{"status": "rejected", "error": {"httpStatus": 500}}]
                }
            }

        with Collector(refused) as server:
            recorder = self.make_recorder(server, event_retry_max_sends=1)
            for _ in range(5):
                self.record(recorder)
                self.assertTrue(recorder.flush(1000))
            self.record(recorder)
            self.assertFalse(recorder.flush(20))
            self.assertEqual(len(server.bodies), 15)

    def test_shutdown_stops_after_pass_makes_no_progress(self):
        with Collector(lambda body, index: (503, b"")) as server:
            recorder = server.recorder(flush_interval_ms=60000)
            self.record(recorder)
            self.assertFalse(recorder.shutdown(1000))
            self.assertEqual(len(server.bodies), 3)
            self.assertEqual(recorder.counters()["dropped_by_cause"]["shutdown"], 1)

    def test_stopped_port_failure_does_not_reach_host(self):
        import socket

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            endpoint = f"http://127.0.0.1:{sock.getsockname()[1]}"
        recorder = wayscribe.create_recorder(
            endpoint=endpoint, api_key="key", service="x", environment="development"
        )
        marker = object()
        self.assertIs(
            recorder.journey({"type": "x", "id": "1"}).deliver(
                "send", {}, lambda: marker
            ),
            marker,
        )
        self.assertFalse(recorder.shutdown(1000))
        self.assertEqual(recorder.counters()["dropped"], 1)

    def test_expiry_only_cycle_leaves_breaker_state_unchanged_without_http(self):
        from wayscribe._config import Config
        from wayscribe._diagnostics import Diagnostics
        from wayscribe._transport import Transport, _Pending

        for failures, deadline in ((0, 0.0), (4, 18.0), (5, 60.0)):
            with (
                self.subTest(failures=failures, deadline=deadline),
                Collector() as server,
            ):
                diagnostics = Diagnostics()
                transport = Transport(
                    Config(False, server.endpoint, "key", "test", "development"),
                    diagnostics,
                    clock=lambda: 30.0,
                )
                transport._failures = failures
                transport._opened_until = deadline
                entry = _Pending(b"{}", 1, refused_at=0.0, refused_sends=1)
                transport._inflight = [entry]
                diagnostics.increment("recorded")
                transport._send_cycle([entry])
                self.assertEqual(server.bodies, [])
                self.assertEqual(
                    (transport._failures, transport._opened_until), (failures, deadline)
                )
                self.assertEqual(
                    diagnostics.counters()["dropped_by_cause"]["retry_budget"], 1
                )
                self.assertTrue(transport.flush(0))
                self.assertTrue(transport.shutdown(0))
