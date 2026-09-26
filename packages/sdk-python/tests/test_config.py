from helpers import *


class ConfigTests(unittest.TestCase):
    def test_defaults_and_invalid_settings_do_not_coerce(self):
        c, d, r = setup(
            batch_size=999,
            flush_interval_ms=True,
            request_timeout_ms="15",
            max_event_bytes=999999,
            capture_mode="bad",
            deployment={
                "git_commit": "abc",
                "version": None,
                "private-key": "DO_NOT_LEAK",
            },
            redact=["user.email", 3],
            known_safe_names=["Session_ID", None],
        )
        self.assertTrue(c.enabled)
        self.assertEqual(
            (
                c.batch_size,
                c.flush_interval_ms,
                c.request_timeout_ms,
                c.max_event_bytes,
            ),
            (100, 1000, 1500, 262144),
        )
        self.assertEqual(c.capture_mode, "redacted-payload")
        self.assertEqual(dict(c.deployment), {"gitCommit": "abc"})
        self.assertIn("deployment.version", d.rejected_settings())
        self.assertIn("deployment.*", d.rejected_settings())
        self.assertNotIn("DO_NOT_LEAK", repr(r))
        self.assertEqual(c.known_safe_names, ("sessionid",))

    def test_unreadable_and_required_values_disable_without_leak(self):
        for options in (
            Hostile(),
            {
                "endpoint": "file:///secret",
                "api_key": " ",
                "service": "s" * 129,
                "environment": "e" * 65,
            },
        ):
            out = io.StringIO()
            d = Diagnostics()
            with contextlib.redirect_stderr(out):
                c = resolve_config(options, d)
            self.assertFalse(c.enabled)
            self.assertNotIn("DO_NOT_LEAK", out.getvalue())

    def test_settings_detached_and_runtime_host_input_ignored(self):
        deployment = {"version": "one"}
        c, d, _ = setup(deployment=deployment)
        deployment["version"] = "two"
        e = event(c, d, runtime={"sdk": {"version": "spoof"}})
        self.assertEqual(e["deployment"], {"version": "one"})
        self.assertEqual(
            e["runtime"]["sdk"], {"name": "wayscribe", "version": "0.2.0"}
        )
        self.assertNotIn("hostname", e["runtime"])
