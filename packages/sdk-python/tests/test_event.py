from helpers import *


class EventTests(unittest.TestCase):
    def test_required_identity_refused_without_delivery_accounting(self):
        c, d, _ = setup()
        for fields in (
            {"journey_id": ""},
            {"entity": {"type": "x", "id": "\ud800"}},
            {"operation": "unknown"},
            {"name": "n" * 257},
        ):
            args = dict(
                journey_id="jrn_ok",
                entity={"type": "x", "id": "1"},
                operation="received",
                name="n",
            )
            args.update(fields)
            self.assertIsNone(build_envelope(c, d, **args))
        self.assertEqual(d.counters()["recorded"], 0)

    def test_short_fields_aliases_metadata_and_labels_use_code_points(self):
        c, d, r = setup()
        e = event(
            c,
            d,
            journey_label="😀" * 201,
            aliases={"😀" * 128: "a", "bad": 1, "long": "a" * 513},
            displayable_aliases=["😀" * 128, "bad"],
            metadata={"😀" * 128: "yes", "x" * 129: "no"},
            duration_ms=2**40,
        )
        self.assertEqual(e["journeyLabel"], "😀" * 199 + "…")
        self.assertEqual(e["aliases"], {"😀" * 128: "a"})
        self.assertEqual(e["displayableAliases"], ["😀" * 128])
        self.assertEqual(e["metadata"], {"😀" * 128: "yes", "[KEY_TOO_LONG]": 1})
        self.assertEqual(e["durationMs"], 2147483647)

    def test_fit_larger_payload_then_metadata_and_count_omission_once(self):
        c, d, _ = setup(max_event_bytes=1200)
        e = event(
            c, d, input="i" * 2000, output="o" * 100, metadata={"note": "m" * 100}
        )
        self.assertEqual(e["input"], "[PAYLOAD_TOO_LARGE]")
        self.assertEqual(e["output"], "o" * 100)
        self.assertIn("metadata", e)
        e = event(c, d, input="i" * 80000, metadata={"note": "m" * 2000})
        self.assertEqual(e["input"], "[PAYLOAD_TOO_LARGE]")
        self.assertNotIn("metadata", e)
        self.assertEqual(d.counters()["payloads_omitted"], 3)
        self.assertEqual(d.counters()["payloads_truncated"], 0)

    def test_errors_masked_bounded_and_no_automatic_stack(self):
        c, d, r = setup()
        e = event(
            c,
            d,
            error=ValueError(
                "password=hunter2 Bearer abcdefghijk postgresql://user:pass@host/db "
                + "x" * 5000
            ),
        )
        self.assertNotIn("hunter2", e["error"]["message"])
        self.assertNotIn("abcdefghijk", e["error"]["message"])
        self.assertNotIn("user:pass", e["error"]["message"])
        self.assertLessEqual(len(e["error"]["message"]), 4096)
        self.assertNotIn("stack", e["error"])

    def test_public_personal_values_warn_unchanged_and_unlisted_secret_warns(self):
        c, d, r = setup()
        e = event(
            c,
            d,
            journey_label="a@example.com",
            aliases={"contact": "a@example.com"},
            displayable_aliases=["contact"],
            input={"vendor_token": "private"},
        )
        self.assertEqual(e["journeyLabel"], "a@example.com")
        self.assertEqual(e["aliases"]["contact"], "a@example.com")
        self.assertEqual(e["input"]["vendor_token"], "private")
        self.assertIn("personal_data", [x["kind"] for x in r])
        self.assertIn("unredacted_secret_name", [x["kind"] for x in r])
        self.assertNotIn("a@example.com", repr(r))
        self.assertNotIn("private", repr(r))
