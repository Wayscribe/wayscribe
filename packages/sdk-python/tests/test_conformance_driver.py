"""The public recorder drives every applicable SDK conformance fixture."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DRIVER = ROOT / "packages/sdk-python/tests/conformance_driver.py"
MANIFEST = ROOT / "packages/protocol/conformance/manifest.json"


class ConformanceDriverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        completed = subprocess.run(
            [sys.executable, str(DRIVER)],
            cwd=ROOT,
            env=os.environ.copy(),
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"driver exited {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        cls.report = json.loads(completed.stdout)

    def test_accounts_for_exact_manifest_case_ids(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))["sdk"]
        executed = [case["id"] for case in self.report["cases"]]
        skipped = [case["id"] for case in self.report["skipped"]]

        self.assertEqual(
            skipped,
            ["sdk/metadata-uncapturable", "sdk/uncapturable-payload"],
        )
        self.assertEqual(sorted(executed + skipped), sorted(manifest))
        self.assertEqual(len(executed), 35)

    def test_reports_the_exact_raw_batches_and_their_events(self):
        by_id = {case["id"]: case for case in self.report["cases"]}
        self.assertEqual(len(by_id["sdk/hundred-and-one-events"]["batches"]), 3)

        for case in self.report["cases"]:
            flattened = []
            for body in case["batches"]:
                self.assertIs(type(body), str)
                parsed = json.loads(body)
                self.assertEqual(list(parsed), ["events"])
                flattened.extend(entry["event"] for entry in parsed["events"])
            self.assertEqual(case["events"], flattened, case["id"])

    def test_reports_public_diagnostics_without_putting_them_on_stdout(self):
        by_id = {case["id"]: case for case in self.report["cases"]}
        diagnostics = [
            diagnostic
            for diagnostic in by_id["sdk/unredacted-secret-name"]["diagnostics"]
            if diagnostic["kind"] == "unredacted_secret_name"
        ]
        self.assertEqual(
            [diagnostic["kind"] for diagnostic in diagnostics],
            ["unredacted_secret_name", "unredacted_secret_name"],
        )
        self.assertNotIn("cfx-fake-sdk-SESSION", json.dumps(diagnostics))


if __name__ == "__main__":
    unittest.main()
