from helpers import *


class BoundaryTests(unittest.TestCase):
    def test_unset_nested_is_absent_and_explicit_null_remains(self):
        c, d, _ = setup()
        self.assertEqual(
            event(c, d, input={"missing": UNSET, "null": None, "array": [UNSET]})[
                "input"
            ],
            {"null": None, "array": [None]},
        )

    def test_error_cut_retains_conformance_marker(self):
        c, d, _ = setup()
        message = event(c, d, error=ValueError("x" * 5000))["error"]["message"]
        self.assertEqual(message, "x" * 4085 + "[TRUNCATED]")

    def test_credential_shapes_and_personal_shape_boundary(self):
        from wayscribe._errors import mask_text, public_warning

        pairs = [
            ("Cookie: session=abc; other=def", "Cookie: [REDACTED]"),
            ('token="hunter2"', 'token="[REDACTED]"'),
            ("https://host/?key=hunter2", "https://host/?key=[REDACTED]"),
            ("Authorization: Bearer aB12cD34", "Authorization: Bearer [REDACTED]"),
            ("DB_PASSWORD=changeme", "DB_PASSWORD=[REDACTED]"),
            ("Invalid token: expired", "Invalid token: expired"),
        ]
        for original, want in pairs:
            self.assertEqual(mask_text(original), want)
            self.assertEqual(mask_text(want), want)
        result = run_isolated("""
            from helpers import *
            from wayscribe._errors import public_warning
            reports = []
            d = Diagnostics(on_diagnostic=reports.append)
            for value in ('email=a@example.com', 'tel:+19195551234'):
                public_warning(value, 'error', d)
            positive = list(reports)
            reports.clear()
            for value in ('git@github.com:org/repo',
                          'postgres://[REDACTED]@db.internal',
                          'Fri Sep 18 +0530 2026', 'Received +12345678 bytes'):
                public_warning(value, 'error', d)
            print(json.dumps({'positive':positive,'negative':reports}))
        """)
        observed = json.loads(result.stdout)
        self.assertEqual(
            [r["detail"]["shape"] for r in observed["positive"]], ["email", "phone"]
        )
        self.assertEqual(observed["negative"], [])
        self.assertEqual(
            result.stderr.splitlines(),
            [
                "[wayscribe] personal_data_in_public_value: The errorMessage holds what looks like an email address; it is stored and shown in plain text.",
                "[wayscribe] personal_data_in_public_value: The errorMessage holds what looks like a telephone number; it is stored and shown in plain text.",
            ],
        )

    def test_secret_name_report_names_bounded_key_and_wildcard_path_not_value(self):
        result = run_isolated("""
            from helpers import *
            c, d, reports = setup()
            event(c, d, input={'list':[{'vendor_token':'do-not-leak'}]})
            print(json.dumps(reports))
        """)
        reports = json.loads(result.stdout)
        report = next(x for x in reports if x["kind"] == "unredacted_secret_name")
        self.assertEqual(report["code"], "secret_like_name")
        self.assertEqual(
            report["detail"],
            {
                "field": "input",
                "name": "vendor_token",
                "path": "input.list[*].vendor_token",
            },
        )
        self.assertNotIn("do-not-leak", repr(reports))
        # As the Node SDK: the printed line names the key and where it was,
        # so it can be fixed, and never the value.
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(
            lines[0].startswith(
                '[wayscribe] unredacted_secret_name: A field named "vendor_token" '
                "(at input.list[*].vendor_token) looks like a secret"
            ),
            lines[0],
        )
        self.assertIn('"**.vendor_token" to redact', lines[0])
        self.assertNotIn("do-not-leak", result.stderr)

    def test_extremely_large_integer_preserves_decimal_digits(self):
        c, d, _ = setup()
        self.assertEqual(event(c, d, input=10**5000)["input"], "1" + "0" * 5000)

    def test_captured_projection_reused_without_fitting_mutating_its_state(self):
        c, d, _ = setup(max_event_bytes=1000)
        snapshot = capture("x" * 700, c)
        event(c, d, input=snapshot, output="y" * 800)
        self.assertFalse(snapshot.omitted)


class ExtraSafetyTests(unittest.TestCase):
    def test_metadata_attempt_does_not_exceed_width_limit(self):
        c, d, _ = setup()
        e = event(c, d, metadata={str(i): i for i in range(1000)}, attempt=2)
        self.assertTrue("metadata" not in e or len(e["metadata"]) <= 1000)

    def test_safe_names_suppress_warning_without_affecting_redaction(self):
        c, d, r = setup(known_safe_names=["vendor-token", "password"])
        e = event(c, d, input={"vendor_token": "private", "password": "private"})
        self.assertEqual(
            e["input"], {"vendor_token": "private", "password": "[REDACTED]"}
        )
        self.assertNotIn("unredacted_secret_name", [x["kind"] for x in r])

    def test_secret_name_warning_not_emitted_for_omitted_payload(self):
        c, d, r = setup(max_event_bytes=1000)
        event(c, d, input={"vendor_token": "private", "data": "x" * 2000})
        self.assertNotIn("unredacted_secret_name", [x["kind"] for x in r])

    def test_dropped_causes_reconcile_without_callback_under_lock(self):
        d = Diagnostics()
        d.increment("recorded", 3)
        d.increment("sent")
        d.increment("dropped", 2, cause="shutdown")
        counts = d.counters()
        self.assertEqual(
            counts["sent"] + counts["rejected"] + counts["dropped"], counts["recorded"]
        )
        self.assertEqual(sum(counts["dropped_by_cause"].values()), counts["dropped"])

    def test_error_escaped_quotes_and_short_header_credentials(self):
        from wayscribe._errors import mask_text

        self.assertEqual(
            mask_text('\\"password\\":\\"short-secret\\"'),
            '\\"password\\":\\"[REDACTED]\\"',
        )
        self.assertEqual(
            mask_text("Authorization: Bearer aB1"), "Authorization: Bearer [REDACTED]"
        )

    def test_renamed_settings_and_invalid_optional_limits_are_named(self):
        c, d, r = setup(
            max_payload_bytes=4000,
            propagate="full",
            max_concurrent_sends=2,
            max_buffered_events=0,
            request_timeout_ms=0,
            journey_id_secret="short",
        )
        self.assertEqual(c.max_concurrent_sends, 1)
        self.assertEqual(c.max_buffered_events, 1000)
        self.assertIsNone(c.journey_id_secret)
        self.assertEqual(
            set(d.rejected_settings()),
            {
                "max_payload_bytes",
                "propagate",
                "max_concurrent_sends",
                "max_buffered_events",
                "request_timeout_ms",
                "journey_id_secret",
            },
        )


class HostileBoundaryTests(unittest.TestCase):
    def test_mapping_width_cannot_hide_behind_a_false_length(self):
        class Lying(Mapping):
            def __len__(self):
                return 0

            def __iter__(self):
                return iter(str(i) for i in range(1001))

            def __getitem__(self, key):
                return "value"

        c, d, _ = setup()
        e = event(c, d, input=Lying(), metadata=Lying(), aliases=Lying())
        self.assertEqual(e["input"], "[PAYLOAD_TOO_LARGE]")
        self.assertNotIn("metadata", e)
        self.assertLessEqual(len(e["aliases"]), 1000)

    def test_diagnostics_are_silent_by_default_and_callback_payload_is_detached(self):
        d = Diagnostics()
        out = io.StringIO()
        with contextlib.redirect_stderr(out):
            d.emit(
                "capture_error",
                "unexpected_error",
                {"field": "input", "payload": "PRIVATE"},
            )
        self.assertEqual(out.getvalue(), "")

    def test_capture_depth_boundary_and_all_built_in_secret_spellings(self):
        c, d, _ = setup()
        deep = 0
        for _ in range(30):
            deep = {"x": deep}
        self.assertEqual(event(c, d, input=deep)["input"], deep)
        names = [
            "authorization",
            "proxy-authorization",
            "cookie",
            "set-cookie",
            "x-api-key",
            "password",
            "access_token",
            "refresh_token",
            "client_secret",
            "api_key",
            "secret",
            "stripe-signature",
            "x-hub-signature",
            "x-hub-signature-256",
            "x-slack-signature",
            "x-hubspot-signature",
            "x-hubspot-signature-v3",
            "x-twilio-signature",
            "x-shopify-hmac-sha256",
        ]
        payload = {key.upper().replace("-", "_"): "private" for key in names}
        self.assertEqual(
            set(event(c, d, input=payload)["input"].values()), {"[REDACTED]"}
        )


class RepairedIntegerReviewTests(unittest.TestCase):
    def test_decimal_integer_string_is_intact_at_limit_and_omitted_beyond(self):
        c, d, _ = setup()
        self.assertEqual(event(c, d, input=10**65535)["input"], "1" + "0" * 65535)
        for value in (10**65536, -(10**65535), 10**70000):
            self.assertEqual(event(c, d, input=value)["input"], "[PAYLOAD_TOO_LARGE]")
        self.assertEqual(d.counters()["payloads_omitted"], 3)
        self.assertEqual(d.counters()["payloads_truncated"], 0)
