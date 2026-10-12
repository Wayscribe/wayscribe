from helpers import *
from delivery_helpers import Collector
import wayscribe
from wayscribe._errors import capture_error, error_fields
from wayscribe.recorder import _failure

LINES = [f"Opportunity_Lines__c[{i}].Unit_Price__c" for i in range(25)]


class TargetRejected(Exception):
    def __init__(self, message, fields):
        super().__init__(message)
        self.fields = fields


class ExplodingFields(Exception):
    @property
    def fields(self):
        raise RuntimeError("host bug")


class ErrorFieldsTests(unittest.TestCase):
    def test_an_exception_attribute_is_recorded(self):
        c, d, _ = setup()
        e = event(
            c,
            d,
            error=TargetRejected(
                "A phone number is required.",
                ["phone", "BillingAddress.PostalCode", "Opportunity_Lines__c[0].Unit_Price__c"],
            ),
        )
        self.assertEqual(
            e["error"],
            {
                "message": "A phone number is required.",
                "type": "TargetRejected",
                "fields": [
                    "phone",
                    "BillingAddress.PostalCode",
                    "Opportunity_Lines__c[0].Unit_Price__c",
                ],
            },
        )

    def test_a_mapping_key_is_recorded(self):
        _, d, _ = setup()
        out = capture_error(
            {
                "message": "rejected",
                "code": "invalid_property_value",
                "fields": ("status",),
            },
            d,
        )
        self.assertEqual(
            out,
            {"message": "rejected", "code": "invalid_property_value", "fields": ["status"]},
        )

    def test_only_non_empty_strings_survive_cut_to_twenty_and_two_hundred(self):
        self.assertEqual(
            error_fields(["", 42, None, {"path": "phone"}, "😀" * 250] + LINES),
            ["😀" * 200] + LINES[:19],
        )

    def test_entries_that_repair_to_empty_are_dropped(self):
        self.assertIsNone(error_fields(["\x00"]))
        self.assertEqual(error_fields(["\x00phone", "\x00"]), ["phone"])

    def test_anything_but_a_list_or_tuple_is_ignored(self):
        for value in ("phone", {"phone": True}, 7, None, {"phone"}):
            with self.subTest(value=value):
                self.assertIsNone(error_fields(value))

    def test_fields_are_omitted_when_nothing_survives(self):
        _, d, _ = setup()
        for value in ([], ["", ""], [1, 2], "phone"):
            with self.subTest(value=value):
                out = capture_error(TargetRejected("rejected", value), d)
                self.assertEqual(out, {"message": "rejected", "type": "TargetRejected"})

    def test_a_throwing_fields_property_never_escapes(self):
        c, d, reports = setup()
        e = event(c, d, error=ExplodingFields("A phone number is required."))
        self.assertEqual(
            e["error"],
            {"message": "A phone number is required.", "type": "ExplodingFields"},
        )
        self.assertIn("capture_error", [r["kind"] for r in reports])

    def test_an_is_failure_mapping_passes_its_fields(self):
        self.assertEqual(
            _failure(
                {"code": "phone_required", "fields": ["phone"]},
                "deliver-customer-to-target",
            ),
            {
                "message": "deliver-customer-to-target reported a failed result.",
                "code": "phone_required",
                "fields": ["phone"],
            },
        )
        self.assertEqual(
            _failure({"code": "phone_required"}, "deliver-customer-to-target"),
            {
                "message": "deliver-customer-to-target reported a failed result.",
                "code": "phone_required",
            },
        )


class RecordingPathTests(unittest.TestCase):
    def setUp(self):
        self.server = self.enterContext(Collector())
        self.recorder = self.server.recorder(flush_interval_ms=60000)
        self.addCleanup(self.recorder.shutdown)
        self.journey = self.recorder.journey({"type": "customer", "id": "42"})

    def events(self):
        self.assertTrue(self.recorder.flush())
        return self.server.events()

    def test_a_raised_exception_records_its_fields(self):
        def fails():
            raise TargetRejected("A phone number is required.", ["phone", ""])

        with self.assertRaises(TargetRejected):
            self.journey.deliver("send", {}, fails)
        self.assertEqual(
            self.events()[0]["error"]["fields"],
            ["phone"],
        )

    def test_an_is_failure_reason_records_its_fields(self):
        result = {"status": 422}
        self.assertIs(
            self.journey.deliver(
                "send",
                {},
                lambda: result,
                is_failure=lambda r: {
                    "code": "phone_required",
                    "message": "A phone number is required.",
                    "fields": ["phone", 7],
                },
            ),
            result,
        )
        self.assertEqual(
            self.events()[0]["error"],
            {
                "code": "phone_required",
                "message": "A phone number is required.",
                "fields": ["phone"],
            },
        )

    def test_a_raising_is_failure_mapping_drops_only_fields(self):
        class Raising(dict):
            def __contains__(self, key):
                raise RuntimeError("host bug")

            def get(self, key, default=None):
                if key == "fields":
                    raise RuntimeError("host bug")
                return super().get(key, default)

        result = {"status": 422}
        self.journey.deliver(
            "send",
            {},
            lambda: result,
            is_failure=lambda r: Raising(code="phone_required", message="rejected"),
        )
        self.assertEqual(
            self.events()[0]["error"],
            {"code": "phone_required", "message": "rejected"},
        )


if __name__ == "__main__":
    unittest.main()
