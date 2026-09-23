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
        result = run_isolated("""
            from helpers import *
            c, d, reports = setup()
            e = event(c, d, journey_label='a@example.com',
                      aliases={'contact':'a@example.com'},
                      displayable_aliases=['contact'], input={'vendor_token':'private'})
            print(json.dumps({'event':e,'reports':reports}))
        """)
        observed = json.loads(result.stdout)
        e, reports = observed["event"], observed["reports"]
        self.assertEqual(e["journeyLabel"], "a@example.com")
        self.assertEqual(e["aliases"]["contact"], "a@example.com")
        self.assertEqual(e["input"]["vendor_token"], "private")
        self.assertEqual(
            [x["kind"] for x in reports],
            [
                "personal_data_in_public_value",
                "personal_data_in_public_value",
                "unredacted_secret_name",
            ],
        )
        self.assertNotIn("a@example.com", repr(reports))
        self.assertNotIn("private", repr(reports))
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 3, lines)
        self.assertIn("The journeyLabel holds what looks like an email", lines[0])
        self.assertIn("The displayableAliases holds what looks like an email", lines[1])
        self.assertIn('named "vendor_token" (at input.vendor_token)', lines[2])
        self.assertNotIn("a@example.com", result.stderr)
        self.assertNotIn("private", result.stderr)

    def test_secret_name_diagnostic_path_starts_at_the_public_event_field(self):
        c, d, reports = setup()
        event(
            c,
            d,
            input={
                "sessionCredential": "secret-value",
                "lines": [{"settings": {"authToken": "another-secret"}}],
            },
        )

        warnings = [
            report for report in reports if report["kind"] == "unredacted_secret_name"
        ]
        self.assertEqual(
            [(r["detail"]["field"], r["detail"]["path"]) for r in warnings],
            [
                ("input", "input.sessionCredential"),
                ("input", "input.lines[*].settings.authToken"),
            ],
        )

    def test_secret_name_path_of_a_list_payload_joins_the_field_like_node(self):
        # Node writes input[*].x; the field and the index are never split by a
        # dot, whether the payload is a list or a header-shaped pair list.
        for payload, path in (
            ([{"authToken": "secret-value"}], "input[*].authToken"),
            ([["x-vendor-token", "secret-value"]], "input[*]"),
            ([[{"apiToken": "secret-value"}]], "input[*][*].apiToken"),
        ):
            with self.subTest(path=path):
                c, d, reports = setup()
                event(c, d, input=payload)
                self.assertEqual(
                    [
                        r["detail"]["path"]
                        for r in reports
                        if r["kind"] == "unredacted_secret_name"
                    ],
                    [path],
                )

    def test_secret_names_are_bounded_as_node_bounds_them(self):
        c, d, reports = setup()
        event(c, d, input={f"vendor{i}Token": "secret-value" for i in range(150)})
        event(c, d, input={"z" * 300 + "Token": "secret-value"})
        warnings = [r for r in reports if r["kind"] == "unredacted_secret_name"]
        self.assertEqual(len(warnings), 100)
        self.assertEqual(d.counters()["unredacted_secret_names"], 100)
        deep = {"a" * 200: {"b" * 200: {"authToken": "secret-value"}}}
        c, d, reports = setup()
        event(c, d, input=deep)
        (warning,) = [r for r in reports if r["kind"] == "unredacted_secret_name"]
        self.assertEqual(len(warning["detail"]["path"]), 256)
        self.assertLessEqual(len(warning["detail"]["name"]), 128)


class EntitySnapshotReviewTests(unittest.TestCase):
    def test_entity_values_are_read_once_and_serialized_from_validated_snapshot(self):
        class Changing(Mapping):
            def __init__(self):
                self.reads = {"type": 0, "id": 0}

            def __iter__(self):
                return iter(self.reads)

            def __len__(self):
                return 2

            def __getitem__(self, key):
                self.reads[key] += 1
                if self.reads[key] == 1:
                    return {"type": "order", "id": "42"}[key]
                return {"type": {}, "id": ""}[key]

        c, d, _ = setup()
        entity = Changing()
        wire = build_envelope(
            c,
            d,
            journey_id="jrn_snapshot",
            entity=entity,
            operation="received",
            name="receive",
        )
        self.assertEqual(
            json.loads(wire)["event"]["entity"], {"type": "order", "id": "42"}
        )
        self.assertEqual(entity.reads, {"type": 1, "id": 1})

    def test_reentrant_diagnostic_cannot_mutate_validated_identity(self):
        c, d, _ = setup()
        entity = {"type": "order", "id": "42"}
        reports = []

        def callback(report):
            reports.append(report)
            entity.update(type={}, id="")

        d.configure(on_diagnostic=callback)
        wire = build_envelope(
            c,
            d,
            journey_id="jrn_snapshot",
            entity=entity,
            operation="received",
            name="receive",
            timestamp="invalid",
        )
        self.assertEqual(
            json.loads(wire)["event"]["entity"], {"type": "order", "id": "42"}
        )
        self.assertEqual(
            [(r["kind"], r["code"], r["detail"]) for r in reports],
            [("configuration_error", "setting_unusable", {"setting": "timestamp"})],
        )
        self.assertEqual(entity, {"type": {}, "id": ""})
