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
