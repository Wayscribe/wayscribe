from helpers import *


class DiagnosticsTests(unittest.TestCase):
    def test_callbacks_reentrant_and_throwing_are_isolated_and_snapshots_detached(self):
        d = Diagnostics()
        d.configure(on_diagnostic=lambda e: d.counters())
        d.emit("capture_error", field="input", payload="DO_NOT_LEAK")
        d.configure(
            on_diagnostic=lambda e: (_ for _ in ()).throw(RuntimeError("DO_NOT_LEAK"))
        )
        d.emit("capture_error", field="input")
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
        self.assertEqual([x["field"] for x in reports], ["input", "output", "metadata"])
        self.assertEqual(
            result.stderr.splitlines(),
            [
                "[wayscribe] kind=unredacted_secret_name field=input code=add_redaction_or_known_safe_name"
            ],
        )
        self.assertNotIn("ReviewVendor", result.stderr)
        self.assertNotIn("request", result.stderr)

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
                {"kind": "personal_data", "field": "journey_label", "shape": "email"},
                {"kind": "personal_data", "field": "error", "shape": "email"},
                {
                    "kind": "personal_data",
                    "field": "displayable_alias",
                    "shape": "email",
                },
                {"kind": "personal_data", "field": "journey_label", "shape": "phone"},
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
            [{"kind": "personal_data", "field": "journey_label", "shape": "email"}],
        )
        self.assertEqual(
            result.stderr.splitlines(),
            ["[wayscribe] kind=personal_data field=journey_label shape=email"],
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
            [{"kind": "personal_data", "field": "journey_label", "shape": "email"}],
        )
        self.assertEqual(
            result.stderr.splitlines(),
            [
                "[wayscribe] kind=personal_data field=journey_label shape=email",
                "[wayscribe] kind=personal_data field=journey_label shape=email",
            ],
        )
