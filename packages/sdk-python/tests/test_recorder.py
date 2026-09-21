import contextlib
import io
import unittest

import wayscribe
from delivery_helpers import Collector, CountingMapping


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            callable(getattr(wayscribe, "create_recorder", None)),
            "public recorder facade is missing",
        )

    def test_journey_identity_context_label_alias_and_terminal_events(self):
        with Collector() as server:
            with server.recorder(journey_id_secret="x" * 32) as recorder:
                entity = {"type": "invoice", "id": "42"}
                journey = recorder.journey(entity, label="First")
                entity["id"] = "mutated"
                context = journey.context()
                context["entity"]["id"] = "also mutated"
                journey.identify(
                    {"external": "EX-42"}, displayable_aliases=["external"]
                )
                journey.label("Second")
                journey.label("")
                journey.record(operation="received", name="in", input=None)
                journey.fail("terminal", ValueError("stop"))
                journey.complete()
                derived = recorder.for_entity({"type": "invoice", "id": "42"})
                self.assertEqual(
                    derived.context(),
                    recorder.for_entity({"type": "invoice", "id": "42"}).context(),
                )
                resumed = recorder.resume(
                    journey.context(), entity={"type": "invoice", "id": "42"}
                )
                self.assertEqual(resumed.context(), journey.context())
                fallback = recorder.resume(
                    {"journeyId": "bad / value"}, entity={"type": "invoice", "id": "42"}
                )
                self.assertTrue(fallback.context()["journeyId"].startswith("jrn_"))
            events = server.events()
            self.assertEqual(
                [e["operation"] for e in events],
                ["identified", "received", "failed", "completed"],
            )
            self.assertEqual(events[0]["aliases"], {"external": "EX-42"})
            self.assertEqual(events[0]["displayableAliases"], ["external"])
            self.assertEqual(events[0]["journeyLabel"], "First")
            self.assertEqual(events[1]["journeyLabel"], "Second")
            self.assertIsNone(events[1]["input"])
            self.assertEqual(events[0]["entity"]["id"], "42")
            self.assertEqual(recorder.counters()["sent"], 4)

    def test_invalid_config_and_identity_do_not_break_host_or_open_network(self):
        with contextlib.redirect_stderr(io.StringIO()):
            recorder = wayscribe.create_recorder()
        marker = object()
        journey = recorder.journey(None)
        self.assertIs(journey.transform("works", {}, lambda: marker), marker)
        self.assertTrue(recorder.shutdown())
        self.assertEqual(
            set(recorder.rejected_settings()),
            {"endpoint", "api_key", "service", "environment"},
        )
        self.assertEqual(recorder.counters()["recorded"], 0)
        with Collector() as server:
            with server.recorder() as valid:
                valid.journey(None).record(operation="received", name="bad")
                valid.journey({"type": "x", "id": "1"}).record(
                    operation="unknown", name="bad"
                )
            self.assertEqual(server.bodies, [])
            self.assertEqual(valid.counters()["recorded"], 0)

    def test_reentrant_diagnostics_can_shutdown_without_deadlock(self):
        with Collector() as server:
            recorder = server.recorder()
            recorder._diagnostics.configure(
                on_diagnostic=lambda report: recorder.shutdown(timeout_ms=1)
            )
            recorder.journey({"type": "x", "id": "1"}).record(
                operation="received", name="record", input=object()
            )
            counts = recorder.counters()
            self.assertEqual(
                counts["recorded"],
                counts["sent"] + counts["dropped"] + counts["rejected"],
            )
            self.assertEqual(counts["dropped_by_cause"]["after_shutdown"], 1)

    def test_across_record_snapshots_metadata_and_aliases_before_diagnostics(self):
        with Collector() as server:
            recorder = server.recorder(flush_interval_ms=60000)
            aliases, metadata = {"external": "before"}, {"state": "before"}

            def mutate(report):
                aliases["external"] = "after"
                metadata["state"] = "after"

            recorder._diagnostics.configure(on_diagnostic=mutate)
            targets = [recorder.journey({"type": "x", "id": str(i)}) for i in range(2)]
            recorder.across(targets).record(
                operation="received",
                name="all",
                aliases=aliases,
                metadata=metadata,
                input=object(),
            )
            self.assertTrue(recorder.shutdown())
            for event in server.events():
                self.assertEqual(event["aliases"], {"external": "before"})
                self.assertEqual(event["metadata"], {"state": "before"})

    def test_resume_checks_event_id_limit_without_changing_carrier_parser(self):
        with Collector() as server:
            reports = []
            recorder = server.recorder(on_diagnostic=reports.append)
            for length in (128, 129, 256):
                identifier = "jrn_" + "a" * (length - 4)
                parsed = wayscribe.extract_http_context(
                    {"x-wayscribe-journey-id": identifier}
                )
                self.assertEqual(parsed, {"journeyId": identifier})
                journey = recorder.resume(parsed, entity={"type": "x", "id": "1"})
                if length == 128:
                    self.assertEqual(journey.context()["journeyId"], identifier)
                else:
                    self.assertNotEqual(journey.context()["journeyId"], identifier)
                journey.complete()
            self.assertTrue(recorder.shutdown())
            self.assertEqual(len(server.events()), 3)
            invalid = [r for r in reports if r["kind"] == "invalid_option"]
            self.assertEqual(len(invalid), 2)
            self.assertNotIn("a" * 129, str(reports))

    def test_unreadable_payload_or_metadata_type_does_not_lose_event(self):
        class HostileType:
            @property
            def __class__(self):
                raise RuntimeError("unreadable type")

        with Collector() as server:
            recorder = server.recorder()
            journey = recorder.journey({"type": "x", "id": "1"})
            journey.record(operation="received", name="payload", input=HostileType())
            journey.record(
                operation="received", name="metadata", metadata=HostileType()
            )
            self.assertTrue(recorder.shutdown())
            events = server.events()
            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["input"], "[UNCAPTURABLE]")
            self.assertNotIn("metadata", events[1])

    def test_alias_snapshot_rejects_oversize_before_value_reads_and_caps_lying_iterator(
        self,
    ):
        for reported_size, repeated, expected_reads, expected_aliases in (
            (2001, False, 0, 0),
            (1, False, 1000, 1000),
            (1, True, 1000, 1),
        ):
            with self.subTest(reported_size=reported_size, repeated=repeated):
                aliases = CountingMapping(
                    reported_size=reported_size, repeated=repeated
                )
                reports = []
                with Collector() as server:
                    recorder = server.recorder(on_diagnostic=reports.append)
                    journey = recorder.journey({"type": "x", "id": "1"})
                    journey.record(
                        operation="identified",
                        name="identify",
                        aliases=aliases,
                        metadata={"valid": True},
                        output={"ok": True},
                    )
                    self.assertEqual(aliases.reads, expected_reads)
                    self.assertLessEqual(aliases.iterations, 1001)
                    self.assertTrue(recorder.shutdown())
                    event = server.events()[0]
                    self.assertEqual(len(event["aliases"]), expected_aliases)
                    self.assertEqual(event["metadata"], {"valid": True})
                    self.assertEqual(event["output"], {"ok": True})
                    self.assertTrue(any(r.get("field") == "aliases" for r in reports))
                    self.assertNotIn("kept", str(reports))

    def test_displayable_alias_snapshot_copies_only_supported_prefix(self):
        import tracemalloc

        for container in (list, tuple):
            with self.subTest(container=container.__name__), Collector() as server:
                recorder = server.recorder(flush_interval_ms=60000)
                journey = recorder.journey({"type": "x", "id": "1"})
                display = container(["external"] * 200000 + ["outside"])
                tracemalloc.start()
                try:
                    journey.identify(
                        {"external": "shown", "outside": "hidden"},
                        displayable_aliases=display,
                    )
                    _, peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
                self.assertLess(peak, 512 * 1024)
                self.assertTrue(recorder.shutdown())
                self.assertEqual(server.events()[0]["displayableAliases"], ["external"])
