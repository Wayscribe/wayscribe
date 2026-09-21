import asyncio
import inspect
import unittest
import warnings

import wayscribe
from delivery_helpers import Collector


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            callable(getattr(wayscribe, "create_recorder", None)),
            "public recorder facade is missing",
        )
        self.server = self.enterContext(Collector())
        self.recorder = self.server.recorder(flush_interval_ms=60000)
        self.addCleanup(self.recorder.shutdown)
        self.journey = self.recorder.journey({"type": "invoice", "id": "42"})

    def events(self):
        self.assertTrue(self.recorder.flush())
        return self.server.events()

    def test_sync_results_exceptions_and_pre_callback_input_snapshot(self):
        data = {"state": "before", "password": "private"}
        marker = object()

        def callback():
            data["state"] = "after"
            return marker

        self.assertIs(self.journey.transform("normalize", data, callback), marker)
        problem = ValueError("host sentinel")

        def fails():
            raise problem

        try:
            self.journey.deliver("send", {}, fails, attempt=2)
        except ValueError as actual:
            self.assertIs(actual, problem)
        else:
            self.fail("host exception swallowed")
        events = self.events()
        self.assertEqual(
            events[0]["input"], {"state": "before", "password": "[REDACTED]"}
        )
        self.assertEqual(events[1]["operation"], "retried")
        self.assertEqual(events[1]["metadata"], {"attempt": 2})
        self.assertEqual(events[1]["error"]["message"], "host sentinel")
        self.assertNotIn("output", events[1])

    def test_projections_snapshot_and_failures_do_not_change_result(self):
        value = {"nested": {"state": "before"}}

        def work():
            value["nested"]["state"] = "after"
            return value

        self.assertIs(
            self.journey.persist(
                "write",
                value,
                work,
                capture_input=lambda x: x["nested"],
                capture_output=lambda x: x["nested"],
            ),
            value,
        )

        async def wrong_projection(x):
            return x

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.assertEqual(
                self.journey.publish(
                    "queue",
                    7,
                    lambda: 9,
                    capture_input=wrong_projection,
                    capture_output=lambda x: 1 / 0,
                ),
                9,
            )
            self.assertEqual(caught, [])
        events = self.events()
        self.assertEqual(events[0]["input"], {"state": "before"})
        self.assertEqual(events[0]["output"], {"state": "after"})
        self.assertEqual(events[1]["input"], "[UNCAPTURABLE]")
        self.assertEqual(events[1]["output"], "[UNCAPTURABLE]")
        self.assertEqual(self.recorder.counters()["capture_errors"], 2)

    def test_across_deduplicates_and_callback_runs_once(self):
        other = self.recorder.journey({"type": "invoice", "id": "43"})
        group = self.recorder.across([self.journey, other, self.journey])
        calls = []
        marker = {"ok": True}
        self.assertIs(
            group.validate("validate", {}, lambda: (calls.append(1), marker)[1]), marker
        )
        events = self.events()
        self.assertEqual(calls, [1])
        self.assertEqual(len(events), 2)
        self.assertNotEqual(events[0]["id"], events[1]["id"])
        self.assertNotEqual(events[0]["journeyId"], events[1]["journeyId"])
        self.assertEqual(events[0]["timestamp"], events[1]["timestamp"])
        self.assertEqual(events[0]["durationMs"], events[1]["durationMs"])

    def test_failure_verdict_and_timing_metadata(self):
        response = {"status": 503, "headers": {"retry-after": "2"}}
        self.assertIs(
            self.journey.deliver(
                "send",
                {},
                lambda: response,
                is_failure=lambda x: {"code": "temporary", "message": "try later"},
                metadata={"caller": "kept"},
                metadata_from=lambda result: wayscribe.http_metadata(
                    result, target_url="https://example.com/private"
                ),
            ),
            response,
        )
        self.journey.consume(
            "job",
            {},
            lambda: 4,
            queue_job={
                "queue_name": "jobs",
                "id": "42",
                "timestamp": 1000,
                "processed_on": 1000,
                "attempts_made": 0,
            },
        )
        events = self.events()
        self.assertEqual(
            events[0]["error"], {"code": "temporary", "message": "try later"}
        )
        self.assertEqual(
            events[0]["metadata"],
            {
                "caller": "kept",
                "httpStatusCode": 503,
                "retryAfterMs": 2000,
                "targetHost": "example.com",
            },
        )
        self.assertEqual(events[1]["metadata"]["queueWaitMs"], 0)
        self.assertEqual(events[1]["operation"], "consumed")

    def test_async_shape_result_exception_and_cancellation(self):
        async def run():
            marker = object()

            async def success():
                return marker

            produced = self.journey.transform("async", {}, success)
            self.assertTrue(inspect.isawaitable(produced))
            self.assertIs(await produced, marker)
            problem = RuntimeError("same error")

            async def fails():
                raise problem

            try:
                await self.journey.deliver("async-error", {}, fails)
            except RuntimeError as actual:
                self.assertIs(actual, problem)
            cancellation = asyncio.CancelledError("same cancellation")

            async def cancelled():
                raise cancellation

            try:
                await self.journey.consume("cancelled", {}, cancelled)
            except asyncio.CancelledError as actual:
                self.assertIs(actual, cancellation)
            else:
                self.fail("cancellation swallowed")

        asyncio.run(run())
        self.assertEqual(
            [x["operation"] for x in self.events()],
            ["transformed", "delivered", "consumed"],
        )

    def test_failed_classifier_and_diagnostics_keep_host_result(self):
        self.recorder._diagnostics.configure(on_diagnostic=lambda report: 1 / 0)
        marker = {"ok": True}
        self.assertIs(
            self.journey.validate(
                "check", {}, lambda: marker, is_failure=lambda result: 1 / 0
            ),
            marker,
        )
        event = self.events()[0]
        self.assertEqual(event["output"], marker)
        self.assertNotIn("error", event)

    def test_static_metadata_capture_retains_warnings_and_truncation(self):
        reports = []
        self.recorder._diagnostics.configure(on_diagnostic=reports.append)
        metadata = {
            "long": "x" * 70000,
            "state": "before",
            "privateToken": "credential",
        }
        aliases = {"external": "before"}

        def work():
            metadata["state"] = "after"
            aliases["external"] = "after"
            return 1

        import contextlib
        import io

        with contextlib.redirect_stderr(io.StringIO()):
            self.journey.persist("write", {}, work, metadata=metadata, aliases=aliases)
        event = self.events()[0]
        self.assertEqual(event["metadata"]["state"], "before")
        self.assertEqual(event["aliases"], {"external": "before"})
        self.assertEqual(self.recorder.counters()["payloads_truncated"], 1)
        self.assertEqual(self.recorder.counters()["unredacted_secret_names"], 1)
        self.assertTrue(any(r["kind"] == "unredacted_secret_name" for r in reports))

    def test_internal_timestamp_failure_cannot_skip_host_callback(self):
        from unittest.mock import patch

        marker = object()
        with patch(
            "wayscribe.recorder.now_timestamp", side_effect=RuntimeError("internal")
        ):
            self.assertIs(
                self.journey.transform("internal", {}, lambda: marker), marker
            )

    def test_across_context_projections_and_recorded_count_exceed_queue_capacity(self):
        with Collector() as server:
            recorder = server.recorder(max_buffered_events=1, flush_interval_ms=60000)
            group = recorder.across(
                [recorder.journey({"type": "x", "id": str(i)}) for i in range(3)]
            )
            group.record(operation="received", name="all")
            self.assertEqual(recorder.counters()["recorded"], 3)
            self.assertEqual(recorder.counters()["dropped_by_cause"]["queue_full"], 2)
            self.assertTrue(recorder.shutdown())
        other = self.recorder.journey({"type": "x", "id": "other"})
        self.recorder.across([self.journey, other]).transform(
            "project",
            {},
            lambda: 1,
            capture_input=lambda value, context: context["entity"]["id"],
        )
        self.assertEqual([e["input"] for e in self.events()], ["42", "other"])

    def test_unreadable_result_type_and_projection_typeerror_preserve_result(self):
        class HostileResult:
            @property
            def __class__(self):
                raise RuntimeError("host type accessor")

        marker = HostileResult()
        self.assertIs(self.journey.deliver("type", {}, lambda: marker), marker)
        calls = []

        def bad_projection(value, context=None):
            calls.append(1)
            raise TypeError("inside projection, not arity")

        self.assertEqual(
            self.journey.transform(
                "projection", {}, lambda: 1, capture_output=bad_projection
            ),
            1,
        )
        self.assertEqual(calls, [1])
        self.assertEqual(self.events()[-1]["output"], "[UNCAPTURABLE]")
