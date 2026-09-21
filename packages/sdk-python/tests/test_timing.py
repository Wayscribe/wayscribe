import unittest
from wayscribe.timing import queue_metadata, http_metadata


class TimingTests(unittest.TestCase):
    def test_queue_zero_unknown_retry_and_redelivery(self):
        job = {
            "queue_name": "q",
            "id": "a",
            "timestamp": 100,
            "processed_on": 100,
            "attempts_made": 0,
        }
        self.assertEqual(
            queue_metadata(job),
            {
                "queue": "q",
                "retryGroup": 'queue:["q","a"]',
                "attempt": 1,
                "queueWaitMs": 0,
                "queueWaitBasis": "initial-enqueue",
            },
        )
        self.assertNotIn("queueWaitMs", queue_metadata(job, delivery_count=2))
        job["attempts_made"] = 1
        job["processed_on"] = 150
        self.assertNotIn("queueWaitMs", queue_metadata(job))
        self.assertEqual(queue_metadata(job, ready_again_at=120)["queueWaitMs"], 30)
        self.assertEqual(
            queue_metadata(job, ready_again_at=120)["queueWaitBasis"], "retry-ready"
        )
        self.assertNotIn("queueWaitMs", queue_metadata(job, ready_again_at=151))
        self.assertEqual(queue_metadata({}), {})
        self.assertNotIn(
            "retryGroup", queue_metadata({"queue_name": "q" * 128, "id": "a" * 128})
        )
        self.assertNotIn("queue", queue_metadata({"queue_name": "[REDACTED]"}))

    def test_http_fields_are_independent_and_host_only(self):
        self.assertEqual(
            http_metadata(
                {"status": 429, "headers": {"Retry-After": "0"}},
                target_url="https://user:password@EXAMPLE.com:8443/private?q=secret",
            ),
            {
                "targetHost": "example.com:8443",
                "httpStatusCode": 429,
                "retryAfterMs": 0,
            },
        )

        class Bad:
            @property
            def status(self):
                raise RuntimeError("private")

            headers = {"retry-after": "2"}

        self.assertEqual(http_metadata(Bad()), {"retryAfterMs": 2000})
        self.assertEqual(
            http_metadata(
                {"status": True, "headers": {"retry-after": "-1"}},
                target_url="file:///private",
            ),
            {},
        )

    def test_http_dates_strict_dates_and_no_negative_clamping(self):
        response = lambda date: {"headers": {"retry-after": date}}
        self.assertEqual(
            http_metadata(response("Sun, 06 Nov 1994 08:49:37 GMT"), now=784111776000),
            {"retryAfterMs": 1000},
        )
        self.assertEqual(
            http_metadata(response("Sunday, 06-Nov-94 08:49:37 GMT"), now=784111776000),
            {"retryAfterMs": 1000},
        )
        self.assertEqual(
            http_metadata(response("Sun Nov  6 08:49:37 1994"), now=784111776000),
            {"retryAfterMs": 1000},
        )
        for date in (
            "Mon, 06 Nov 1994 08:49:37 GMT",
            "Sun, 31 Feb 1994 08:49:37 GMT",
            "1994-11-06",
            "1.5",
            "99999999999999999",
        ):
            self.assertEqual(http_metadata(response(date), now=784111776000), {})
        self.assertEqual(
            http_metadata(response("Sun, 06 Nov 1994 08:49:37 GMT"), now=784111778000),
            {},
        )
