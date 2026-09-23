import json
from pathlib import Path
import unittest
from wayscribe import propagation as p
from wayscribe._diagnostics import Diagnostics
from helpers import run_isolated

FIXTURES = Path(__file__).resolve().parents[2] / "protocol" / "fixtures"


class PropagationTests(unittest.TestCase):
    def test_every_literal_vector(self):
        vectors = json.loads((FIXTURES / "propagation.json").read_text())
        self.assertEqual(len(vectors["cases"]), 43)
        for case in vectors["cases"]:
            with self.subTest(case=case["name"]):
                data = case["input"]
                carrier = case["carrier"]
                action = case["action"]
                if action == "inject":
                    fn = {
                        "http": p.inject_http_headers,
                        "sqs": p.inject_sqs_attributes,
                        "payload": p.inject_payload,
                    }[carrier]
                    original = json.dumps(data, sort_keys=True)
                    result = fn(
                        data["context"],
                        data.get("data") if carrier == "payload" else data["carrier"],
                        level=data["level"],
                    )
                    self.assertEqual(json.dumps(data, sort_keys=True), original)
                else:
                    result = {
                        "http": p.extract_http_context,
                        "sqs": p.extract_sqs_context,
                        "payload": p.extract_payload,
                    }[carrier](data["carrier"])
                self.assertEqual(result, case["expected"])

    def test_all_derivation_vectors_and_refused_fallbacks(self):
        vectors = json.loads((FIXTURES / "journey-id-derivation.json").read_text())
        d = Diagnostics()
        reports = []
        d.configure(on_diagnostic=reports.append)
        for case in vectors["vectors"]:
            self.assertEqual(
                p.derive_journey_id(
                    case["secret"], case["environment"], case["entity"], d
                ),
                case["journeyId"],
            )
        refused = (
            vectors["refused"]
            + vectors["refusedEmpty"]
            + [
                dict(secret=None, environment="dev", entity={}),
                dict(
                    secret="short", environment="dev", entity={"type": "x", "id": "1"}
                ),
            ]
        )
        result = run_isolated(f"""
            from helpers import *
            from wayscribe import propagation as p
            reports = []
            d = Diagnostics(on_diagnostic=reports.append)
            ids = []
            for case in {refused!r}:
                for _ in range(2):
                    ids.append(p.derive_journey_id(
                        case['secret'], case['environment'], case['entity'], d))
            print(json.dumps({{'ids':ids, 'reports':reports}}))
        """)
        observed = json.loads(result.stdout)
        for value in observed["ids"]:
            self.assertRegex(value, "^jrn_[0-9a-f-]{36}$")
        self.assertEqual(len(set(observed["ids"])), len(refused) * 2)
        self.assertEqual(len(observed["reports"]), len(observed["ids"]))
        self.assertEqual(
            {(r["kind"], r["code"]) for r in observed["reports"]},
            {
                ("configuration_error", "entity_invalid"),
                ("configuration_error", "journey_id_secret_missing"),
                ("configuration_error", "journey_id_secret_unusable"),
            },
        )
        # A missing or short secret prints once per process (SDK-56).
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertTrue(
            lines[0].startswith("[wayscribe] configuration_error: No journey_id_secret")
        )

    def test_structural_guard_and_hostile_carriers(self):
        self.assertTrue(p.has_journey({"_wayscribe": {"journeyId": "unvalidated"}}))
        self.assertIsNone(
            p.extract_payload({"_wayscribe": {"journeyId": "unvalidated"}, "data": 42})[
                "context"
            ]
        )

        class Bad(dict):
            def get(self, *args):
                raise RuntimeError("secret")

            def items(self):
                raise RuntimeError("secret")

        self.assertIsNone(p.extract_http_context(Bad()))
        self.assertIsNone(p.extract_sqs_context(Bad()))
        self.assertFalse(p.has_journey(Bad()))
        self.assertEqual(p.extract_payload(42), {"context": None, "data": 42})
