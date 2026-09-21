from helpers import *


class CaptureTests(unittest.TestCase):
    def test_detached_secrets_paths_and_shared_references(self):
        c, d, _ = setup(redact=["user.email"])
        shared = {"name": "Ada", "API_KEY": "secret"}
        payload = {"one": shared, "two": shared, "user": {"email": "private"}}
        e = event(c, d, input=payload)
        shared["name"] = "changed"
        self.assertEqual(
            e["input"],
            {
                "one": {"name": "Ada", "API_KEY": "[REDACTED]"},
                "two": {"name": "Ada", "API_KEY": "[REDACTED]"},
                "user": {"email": "[REDACTED]"},
            },
        )

    def test_all_header_shapes_and_known_header_name_exception(self):
        c, d, _ = setup()
        payload = {
            "pairs": [["Authorization", "private"]],
            "named": [
                {"name": "cookie", "value": "private", "comment": "ok"},
                {"key": "x-api-key", "value": "private"},
            ],
            "raw": [":path", "/", "Authorization", "private"],
            "block": "GET / HTTP/1.1\r\nCookie: private\r\n\r\nbody",
            "names": ["Authorization", "Content-Type"],
        }
        e = event(c, d, input=payload)["input"]
        self.assertEqual(e["pairs"], [["Authorization", "[REDACTED]"]])
        self.assertEqual(e["raw"], [":path", "/", "Authorization", "[REDACTED]"])
        self.assertEqual(
            e["named"][0], {"name": "cookie", "value": "[REDACTED]", "comment": "ok"}
        )
        self.assertEqual(e["named"][1]["value"], "[REDACTED]")
        self.assertEqual(e["names"], payload["names"])
        self.assertEqual(e["block"], "GET / HTTP/1.1\r\nCookie: [REDACTED]\r\n\r\nbody")

    def test_repairs_cycle_numbers_text_bytes_dates_and_hostile_objects(self):
        c, d, r = setup()
        cycle = {}
        cycle["self"] = cycle
        e = event(
            c,
            d,
            input={
                "cycle": cycle,
                "int": 9007199254740992,
                "nan": math.nan,
                "text": "a\x00b\ud800",
                "bytes": b"\x00\xff",
                "date": dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc),
                "bad": Hostile(),
            },
        )["input"]
        self.assertEqual(
            e,
            {
                "cycle": {"self": "[CIRCULAR]"},
                "int": "9007199254740992",
                "nan": None,
                "text": "ab�",
                "bytes": {"type": "bytes", "base64": "AP8="},
                "date": "2026-01-01T00:00:00.000Z",
                "bad": "[UNCAPTURABLE]",
            },
        )
        self.assertNotIn("DO_NOT_LEAK", repr(r))

    def test_secret_masking_precedes_truncation_and_utf16_length(self):
        c, d, _ = setup()
        e = event(c, d, input={"password": "s" * 90000, "text": "😀" * 40000})
        self.assertEqual(e["input"]["password"], "[REDACTED]")
        self.assertEqual(len(e["input"]["text"].encode("utf-16-le")) // 2, 65536)
        self.assertEqual(d.counters()["payloads_truncated"], 1)

    def test_crlf_truncation_keeps_header_boundary(self):
        c, d, _ = setup()
        text = event(c, d, input="x-unlisted: " + "a" * 70000 + "\r\n")["input"]
        self.assertRegex(text, "\\r\\n\\[TRUNCATED: \\d+ characters removed\\]$")

    def test_depth_width_and_shared_expansion_are_bounded(self):
        c, d, _ = setup()
        deep = 0
        for _ in range(31):
            deep = {"x": deep}
        for payload in (deep, list(range(1001)), {str(i): i for i in range(1001)}):
            self.assertEqual(event(c, d, input=payload)["input"], "[PAYLOAD_TOO_LARGE]")
        binary = 1
        for _ in range(25):
            binary = [binary, binary]
        self.assertEqual(event(c, d, input=binary)["input"], "[PAYLOAD_TOO_LARGE]")

    def test_modes_none_and_full_paths(self):
        c, d, _ = setup(capture_mode="metadata-only")
        self.assertNotIn("input", event(c, d, input=None))
        c, d, _ = setup(capture_mode="full-payload", redact=["private"])
        self.assertEqual(
            event(c, d, input={"private": "yes", "secret": "no"})["input"],
            {"private": "yes", "secret": "[REDACTED]"},
        )
        self.assertIsNone(event(c, d, input=None)["input"])
        self.assertNotIn("input", event(c, d))


class CaptureReviewTests(unittest.TestCase):
    def test_positional_header_uses_string_key_when_name_is_not_string(self):
        for mode in ("redacted-payload", "full-payload"):
            for bad_name in (None, 3, False, {}, []):
                with self.subTest(mode=mode, name=bad_name):
                    c, d, _ = setup(capture_mode=mode)
                    original = [
                        {
                            "name": bad_name,
                            "key": "Authorization",
                            "value": "synthetic-credential",
                            "comment": "kept",
                        }
                    ]
                    captured = event(c, d, input=original)["input"]
                    self.assertEqual(
                        captured,
                        [
                            {
                                "name": bad_name,
                                "key": "Authorization",
                                "value": "[REDACTED]",
                                "comment": "kept",
                            }
                        ],
                    )
                    self.assertEqual(original[0]["value"], "synthetic-credential")
                    self.assertNotIn("synthetic-credential", json.dumps(captured))
                    header_names = [
                        {
                            "name": bad_name,
                            "key": "Authorization",
                            "value": "Content-Type",
                            "comment": "kept",
                        }
                    ]
                    self.assertEqual(
                        event(c, d, input=header_names)["input"], header_names
                    )

    def test_bytes_base64_obeys_string_limit_and_reports_truncation(self):
        c, d, _ = setup()
        boundary = event(c, d, input=b"a" * 49152)["input"]
        self.assertEqual(boundary, {"type": "bytes", "base64": "YWFh" * 16384})
        self.assertEqual(d.counters()["payloads_truncated"], 0)
        for value in (b"a" * 49153, bytearray(b"a" * 50000)):
            captured = event(c, d, input=value)["input"]
            self.assertEqual(captured["type"], "bytes")
            self.assertEqual(len(captured["base64"].encode("utf-16-le")) // 2, 65536)
            self.assertRegex(
                captured["base64"], r"\[TRUNCATED: [0-9]+ characters removed\]$"
            )
        self.assertEqual(d.counters()["payloads_truncated"], 2)
        self.assertEqual(d.counters()["payloads_omitted"], 0)

    def test_synthesized_bytes_object_obeys_envelope_depth(self):
        c, d, _ = setup()
        at_limit = b"a"
        for _ in range(29):
            at_limit = {"x": at_limit}
        kept = event(c, d, input=at_limit)["input"]
        for _ in range(29):
            kept = kept["x"]
        self.assertEqual(kept, {"type": "bytes", "base64": "YQ=="})
        self.assertEqual(
            event(c, d, input={"x": at_limit})["input"], "[PAYLOAD_TOO_LARGE]"
        )
        self.assertEqual(d.counters()["payloads_omitted"], 1)
