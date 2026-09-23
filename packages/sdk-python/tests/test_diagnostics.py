from helpers import *
from wayscribe._diagnostics import _reason

PRINTED_LABEL_EMAIL = (
    "[wayscribe] personal_data_in_public_value: The journeyLabel holds what looks "
    "like an email address; it is stored and shown in plain text."
)


def personal(field, shape):
    detail = {"field": field, "shape": shape}
    return {
        "kind": "personal_data_in_public_value",
        "code": "personal_data_shape",
        "reason": _reason(
            "personal_data_in_public_value", "personal_data_shape", detail
        ),
        "detail": detail,
    }


class DiagnosticsTests(unittest.TestCase):
    def test_callbacks_reentrant_and_throwing_are_isolated_and_snapshots_detached(self):
        d = Diagnostics()
        d.configure(on_diagnostic=lambda e: d.counters())
        d.emit("capture_error", "unexpected_error", {"field": "input"})
        d.configure(
            on_diagnostic=lambda e: (_ for _ in ()).throw(RuntimeError("DO_NOT_LEAK"))
        )
        d.emit("capture_error", "unexpected_error", {"field": "input"})
        threads = [
            threading.Thread(
                target=lambda: [d.increment("recorded") for _ in range(100)]
            )
            for _ in range(4)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(2)
            self.assertFalse(t.is_alive())
        snapshot = d.counters()
        self.assertEqual(snapshot["recorded"], 400)
        snapshot["dropped_by_cause"]["shutdown"] = 9
        self.assertEqual(d.counters()["dropped_by_cause"]["shutdown"], 0)


class SuppressionReviewTests(unittest.TestCase):
    def test_secret_warning_prints_once_per_folded_name_across_recorders_and_fields(
        self,
    ):
        result = run_isolated("""
            from helpers import *
            reports = []
            first = Diagnostics(on_diagnostic=reports.append)
            second = Diagnostics(on_diagnostic=reports.append)
            debug = Diagnostics(on_diagnostic=reports.append, log_diagnostics=True)
            first.report_name('input', 'ReviewVendor_token', 'request[*].ReviewVendor_token')
            first.report_name('output', 'REVIEWVENDOR-TOKEN', 'response.REVIEWVENDOR-TOKEN')
            second.report_name('output', 'REVIEWVENDOR-TOKEN', 'response.REVIEWVENDOR-TOKEN')
            debug.report_name('metadata', 'reviewvendortoken', 'reviewvendortoken')
            print(json.dumps(reports))
        """)
        reports = json.loads(result.stdout)
        self.assertEqual(len(reports), 3)
        self.assertEqual(
            [x["detail"]["field"] for x in reports], ["input", "output", "metadata"]
        )
        # Once per process and name with logging off; every report with it on,
        # as the Node SDK. The line names the key and its path, never a value.
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 2, lines)
        self.assertIn(
            'named "ReviewVendor_token" (at request[*].ReviewVendor_token)', lines[0]
        )
        self.assertIn('named "reviewvendortoken" (at reviewvendortoken)', lines[1])

    def test_personal_data_callbacks_and_prints_are_once_per_process_field_and_shape(
        self,
    ):
        result = run_isolated("""
            from helpers import *
            from wayscribe._errors import public_warning
            reports = []
            other = Diagnostics(on_diagnostic=reports.append, log_diagnostics=True)
            def callback(report):
                reports.append(report)
                public_warning('reentrant@example.com', 'journey_label', other)
            first = Diagnostics(on_diagnostic=callback)
            public_warning('first@example.com', 'journey_label', first)
            public_warning('second@example.com', 'journey_label', other)
            public_warning('third@example.com', 'error', other)
            public_warning('fourth@example.com', 'displayable_alias', other)
            public_warning('tel:+19195551234', 'journey_label', other)
            public_warning('tel:+19195559876', 'journey_label', first)
            print(json.dumps(reports))
        """)
        self.assertEqual(
            json.loads(result.stdout),
            [
                personal("journeyLabel", "email"),
                personal("errorMessage", "email"),
                personal("displayableAliases", "email"),
                personal("journeyLabel", "phone"),
            ],
        )
        self.assertEqual(len(result.stderr.splitlines()), 4)
        self.assertNotIn("@", result.stderr)
        self.assertNotIn("1919", result.stderr)

    def test_concurrent_personal_warnings_claim_once_before_callback(self):
        result = run_isolated("""
            from helpers import *
            from wayscribe._errors import public_warning
            reports=[]
            barrier=threading.Barrier(8)
            def warn():
                d=Diagnostics(on_diagnostic=reports.append)
                barrier.wait()
                public_warning('private@example.com','journey_label',d)
            threads=[threading.Thread(target=warn) for _ in range(8)]
            for thread in threads:thread.start()
            for thread in threads:thread.join(2)
            assert not any(thread.is_alive() for thread in threads)
            print(json.dumps(reports))
        """)
        self.assertEqual(
            json.loads(result.stdout),
            [personal("journeyLabel", "email")],
        )
        self.assertEqual(
            result.stderr.splitlines(),
            [PRINTED_LABEL_EMAIL],
        )

    def test_fresh_diagnostics_after_fork_never_waits_on_parent_global_lock(self):
        import os

        if not hasattr(os, "fork"):
            self.skipTest("fork is not available on this platform")
        result = run_isolated("""
            from helpers import *
            import os, select, signal
            import wayscribe._diagnostics as module
            from wayscribe._errors import public_warning
            public_warning('parent@example.com','journey_label',Diagnostics())
            read_fd,write_fd=os.pipe()
            module._process_lock.acquire()
            child=os.fork()
            if child==0:
                os.close(read_fd)
                reports=[]
                fresh=Diagnostics(on_diagnostic=reports.append)
                public_warning('child@example.com','journey_label',fresh)
                os.write(write_fd,json.dumps(reports).encode())
                os._exit(0)
            os.close(write_fd)
            try:
                if select.select([read_fd],[],[],2)[0]:
                    message=os.read(read_fd,4096).decode()
                else:
                    os.kill(child,signal.SIGKILL)
                    message='"blocked on inherited lock"'
                os.waitpid(child,0)
            finally:
                module._process_lock.release()
                os.close(read_fd)
            print(message)
        """)
        self.assertEqual(
            json.loads(result.stdout),
            [personal("journeyLabel", "email")],
        )
        self.assertEqual(
            result.stderr.splitlines(),
            [
                PRINTED_LABEL_EMAIL,
                PRINTED_LABEL_EMAIL,
            ],
        )


class NodeParityTests(unittest.TestCase):
    """Kinds, codes and shape as packages/sdk-node/src/diagnostics.ts has them."""

    def test_every_report_is_kind_code_reason_detail(self):
        from delivery_helpers import Collector

        reports = []
        with Collector() as server:
            recorder = server.recorder(
                on_diagnostic=reports.append, max_concurrent_sends=2
            )
            journey = recorder.journey({"type": "x", "id": "1"}, label=5)
            journey.record(operation="received", name="in", timestamp="bad")
            journey.record(operation="received", name="in")
            self.assertTrue(recorder.shutdown())
        self.assertTrue(reports)
        for report in reports:
            self.assertEqual(set(report), {"kind", "code", "reason", "detail"})
            self.assertIsInstance(report["reason"], str)
            self.assertIsInstance(report["detail"], dict)
        self.assertEqual(
            [(r["kind"], r["code"]) for r in reports],
            [
                ("configuration_error", "setting_unusable"),
                ("key_dropped", "label_invalid"),
                ("configuration_error", "setting_unusable"),
                ("delivered_first", "first_delivery"),
            ],
        )
        self.assertEqual(reports[0]["detail"], {"setting": "max_concurrent_sends"})
        self.assertEqual(
            reports[-1]["detail"],
            {"endpoint": server.endpoint, "accepted": 2},
        )

    def test_delivered_first_once_and_breaker_opened_with_nodes_detail(self):
        from delivery_helpers import Collector

        reports = []
        with Collector(lambda body, index: (503, b"")) as server:
            recorder = server.recorder(on_diagnostic=reports.append, batch_size=1)
            recorder._transport._jitter = lambda: 0
            recorder.journey({"type": "x", "id": "1"}).complete()
            # A flush keeps sending until the breaker opens after five failures.
            self.assertFalse(recorder.flush(1000))
            recorder.shutdown(1000)
        opened = [r for r in reports if r["kind"] == "breaker_opened"]
        self.assertEqual(len(opened), 1)
        self.assertEqual(opened[0]["code"], "consecutive_failures")
        self.assertEqual(opened[0]["detail"], {"failures": 5, "cooldownMs": 30000})
        failed = [r for r in reports if r["kind"] == "transport_error"]
        self.assertEqual(failed[0]["code"], "request_failed")
        self.assertEqual(failed[0]["detail"], {"unsent": 1, "abandoned": 0})
        self.assertNotIn("breaker_open", [r["kind"] for r in reports])

    def test_insecure_endpoint_names_host_and_skips_local_and_internal(self):
        for endpoint, reported in (
            ("http://collector.example.com:8080/base", True),
            ("http://localhost:3000", False),
            ("http://127.0.0.1:3000", False),
            ("http://api:3000", False),
            ("https://collector.example.com", False),
        ):
            with self.subTest(endpoint=endpoint):
                reports = []
                with contextlib.redirect_stderr(io.StringIO()):
                    from wayscribe import create_recorder

                    recorder = create_recorder(
                        endpoint=endpoint,
                        api_key="k",
                        service="s",
                        environment="dev",
                        on_diagnostic=reports.append,
                    )
                insecure = [r for r in reports if r["kind"] == "insecure_endpoint"]
                self.assertEqual(len(insecure), int(reported))
                if reported:
                    self.assertEqual(insecure[0]["code"], "unencrypted_endpoint")
                    self.assertEqual(
                        insecure[0]["detail"],
                        {"scheme": "http:", "host": "collector.example.com"},
                    )
                self.assertTrue(recorder.shutdown(0))
