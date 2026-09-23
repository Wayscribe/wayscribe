import asyncio
import os
import subprocess
import sys
import threading
import time
import unittest
import warnings
from unittest.mock import patch

import wayscribe
from delivery_helpers import Collector, accepted


class ShutdownTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            callable(getattr(wayscribe, "create_recorder", None)),
            "public recorder facade is missing",
        )

    def record(self, recorder):
        recorder.journey({"type": "x", "id": "1"}).record(
            operation="received", name="in"
        )

    def test_deadline_aborts_socket_and_finalizes_once_despite_late_response(self):
        release = threading.Event()
        with Collector(
            lambda body, index: (release.wait(3), accepted(body))[1]
        ) as server:
            recorder = server.recorder(batch_size=1, request_timeout_ms=5000)
            self.record(recorder)
            self.assertTrue(server.received.wait(2))
            self.record(recorder)
            started = time.monotonic()
            self.assertFalse(recorder.shutdown(timeout_ms=25))
            self.assertLess(time.monotonic() - started, 0.3)
            before = recorder.counters()
            self.assertEqual(before["dropped_by_cause"]["shutdown"], 2)
            self.assertFalse(recorder.shutdown(timeout_ms=25))
            release.set()
            recorder._transport._thread.join(1)
            self.assertFalse(recorder._transport._thread.is_alive())
            self.assertEqual(recorder.counters(), before)
            self.assertEqual(len(server.bodies), 1)
            self.record(recorder)
            self.assertEqual(
                recorder.counters()["dropped_by_cause"]["after_shutdown"], 1
            )

    def test_late_connection_completion_cannot_send_headers_or_body(self):
        import http.client

        entered = threading.Event()
        release = threading.Event()
        original = http.client.HTTPConnection.connect

        def delayed(connection):
            entered.set()
            release.wait(3)
            original(connection)

        with (
            Collector() as server,
            patch.object(http.client.HTTPConnection, "connect", delayed),
        ):
            recorder = server.recorder(batch_size=1)
            self.record(recorder)
            self.assertTrue(entered.wait(2))
            self.assertFalse(recorder.shutdown(timeout_ms=10))
            before = recorder.counters()
            release.set()
            recorder._transport._thread.join(2)
            self.assertFalse(recorder._transport._thread.is_alive())
            self.assertEqual(server.bodies, [])
            self.assertEqual(recorder.counters(), before)

    def test_concurrent_record_flush_shutdown_reconciles(self):
        with Collector() as server:
            recorder = server.recorder(batch_size=3)
            barrier = threading.Barrier(7)

            def records():
                barrier.wait()
                for _ in range(50):
                    self.record(recorder)

            def flushes():
                barrier.wait()
                recorder.flush(1000)

            workers = [threading.Thread(target=records) for _ in range(4)]
            workers += [threading.Thread(target=flushes) for _ in range(2)]
            for worker in workers:
                worker.start()
            barrier.wait()
            recorder.shutdown(timeout_ms=1000)
            for worker in workers:
                worker.join(2)
                self.assertFalse(worker.is_alive())
            counts = recorder.counters()
            self.assertEqual(counts["recorded"], 200)
            self.assertEqual(
                counts["recorded"],
                counts["sent"] + counts["rejected"] + counts["dropped"],
            )
            self.assertEqual(
                counts["dropped"], sum(counts["dropped_by_cause"].values())
            )

    def test_async_shutdown_does_not_block_loop_and_contexts_preserve_errors(self):
        release = threading.Event()
        with Collector(
            lambda body, index: (release.wait(3), accepted(body))[1]
        ) as server:

            async def run():
                recorder = server.recorder(batch_size=1)
                self.record(recorder)
                await asyncio.to_thread(server.received.wait, 2)
                progress = []

                async def tick():
                    await asyncio.sleep(0.01)
                    progress.append(1)

                await asyncio.gather(recorder.async_shutdown(50), tick())
                self.assertEqual(progress, [1])
                problem = ValueError("body")
                try:
                    async with server.recorder() as other:
                        raise problem
                except ValueError as actual:
                    self.assertIs(actual, problem)
                self.assertTrue(await other.async_flush())

            asyncio.run(run())
            release.set()

    def test_daemon_worker_and_invalid_config_cannot_keep_process_alive(self):
        with Collector(
            lambda body, index: (time.sleep(1), accepted(body))[1]
        ) as server:
            code = f"""from wayscribe import create_recorder
r = create_recorder(endpoint={server.endpoint!r}, api_key="test", service="x", environment="development", batch_size=1)
r.journey({{"type":"x","id":"1"}}).record(operation="received", name="in")
import time
time.sleep(.05)
"""
            result = subprocess.run(
                [sys.executable, "-c", code], capture_output=True, timeout=4
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from wayscribe import create_recorder; r=create_recorder(); assert r.shutdown()",
            ],
            capture_output=True,
            timeout=2,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(hasattr(os, "fork"), "fork unavailable")
    def test_inherited_recorder_records_in_a_forked_child_without_parent_locks(self):
        # gunicorn --preload and Celery prefork create the recorder before
        # fork: the child's copy must record, not silently do nothing.
        with Collector() as server:
            recorder = server.recorder(flush_interval_ms=60000)
            self.record(recorder)
            read_fd, write_fd = os.pipe()
            # Deliberately inherit locks as held by a thread that vanishes.
            recorder._transport._condition.acquire()
            recorder._diagnostics._lock.acquire()
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    category=DeprecationWarning,
                    message="This process .*multi-threaded",
                )
                pid = os.fork()
            if pid == 0:
                try:
                    os.close(read_fd)
                    # A fresh start: the parent's queued event is the parent's.
                    assert recorder.counters()["recorded"] == 0
                    self.record(recorder)
                    recorder.rejected_settings()
                    recorder.journey({"type": "x", "id": "1"}, label="child").label(
                        "next"
                    )
                    recorder.for_entity({"type": "x", "id": "1"})
                    assert recorder.shutdown(2000)
                    counts = recorder.counters()
                    assert (counts["recorded"], counts["sent"]) == (1, 1), counts
                    with server.recorder() as fresh:
                        self.record(fresh)
                    os.write(write_fd, b"ok")
                    os._exit(0)
                except BaseException:
                    os._exit(1)
            recorder._diagnostics._lock.release()
            recorder._transport._condition.release()
            os.close(write_fd)
            import select

            readable, _, _ = select.select([read_fd], [], [], 3)
            if not readable:
                os.kill(pid, 9)
            _, status = os.waitpid(pid, 0)
            result = os.read(read_fd, 2)
            os.close(read_fd)
            self.assertEqual(status, 0)
            self.assertEqual(result, b"ok")
            self.assertTrue(recorder.shutdown())
            self.assertEqual(recorder.counters()["sent"], 1)
            events = server.events()
            self.assertEqual(len(events), 3)
            self.assertEqual(len({e["id"] for e in events}), 3)

    def test_late_dns_completion_never_sends_and_does_not_mutate_counters(self):
        import socket

        entered, release = threading.Event(), threading.Event()
        original = socket.getaddrinfo

        def delayed(*args, **kwargs):
            entered.set()
            release.wait(3)
            return original(*args, **kwargs)

        with Collector() as server, patch("socket.getaddrinfo", delayed):
            recorder = server.recorder(batch_size=1)
            self.record(recorder)
            self.assertTrue(entered.wait(2))
            self.assertFalse(recorder.shutdown(10))
            counts = recorder.counters()
            release.set()
            recorder._transport._thread.join(2)
            self.assertFalse(recorder._transport._thread.is_alive())
            self.assertEqual(server.bodies, [])
            self.assertEqual(recorder.counters(), counts)

    def test_sender_diagnostic_can_reenter_shutdown_and_deadline_interrupts_backoff(
        self,
    ):
        reports = []
        with Collector(lambda body, index: (503, b"")) as server:
            recorder = server.recorder(batch_size=1)
            recorder._transport._jitter = lambda: 1
            recorder._diagnostics.configure(
                on_diagnostic=lambda report: (
                    reports.append(report),
                    recorder.shutdown(100),
                )
            )
            self.record(recorder)
            self.assertTrue(server.received.wait(1))
            self.assertFalse(recorder.shutdown(5))
            counts = recorder.counters()
            recorder._transport._thread.join(1)
            self.assertFalse(recorder._transport._thread.is_alive())
            self.assertEqual(len(server.bodies), 1)
            self.assertEqual(recorder.counters(), counts)
        with Collector(lambda body, index: (503, b"")) as server:
            recorder = server.recorder(batch_size=1)
            recorder._transport._jitter = lambda: 0
            recorder._diagnostics.configure(
                on_diagnostic=lambda report: recorder.shutdown(100)
            )
            self.record(recorder)
            recorder._transport._thread.join(1)
            self.assertFalse(recorder._transport._thread.is_alive())
            self.assertEqual(recorder.counters()["dropped_by_cause"]["shutdown"], 1)

    def test_cancellation_of_async_shutdown_preserves_cancelled_error_and_finalizes(
        self,
    ):
        release = threading.Event()
        with Collector(
            lambda body, index: (release.wait(3), accepted(body))[1]
        ) as server:
            recorder = server.recorder(batch_size=1)
            self.record(recorder)
            self.assertTrue(server.received.wait(1))

            async def run():
                task = asyncio.create_task(recorder.async_shutdown(5000))
                await asyncio.sleep(0.01)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(recorder.counters()["dropped"], 1)

            asyncio.run(run())
            release.set()

    def test_record_calls_do_not_wait_for_network_and_concurrent_flush_has_one_sender(
        self,
    ):
        entered, release = threading.Event(), threading.Event()
        active = [0, 0]
        lock = threading.Lock()

        def respond(body, index):
            with lock:
                active[0] += 1
                active[1] = max(active)
            entered.set()
            release.wait(2)
            with lock:
                active[0] -= 1
            return accepted(body)

        with Collector(respond) as server:
            recorder = server.recorder(batch_size=1)
            self.record(recorder)
            self.assertTrue(entered.wait(1))
            start = time.monotonic()
            for _ in range(10):
                self.record(recorder)
            self.assertLess(time.monotonic() - start, 0.1)
            flushers = [
                threading.Thread(target=recorder.flush, args=(1000,)) for _ in range(5)
            ]
            for worker in flushers:
                worker.start()
            release.set()
            for worker in flushers:
                worker.join(2)
                self.assertFalse(worker.is_alive())
            self.assertTrue(recorder.shutdown())
            self.assertEqual(active[1], 1)
            self.assertEqual(recorder.counters()["sent"], 11)

    def test_network_timeout_retries_are_bounded_and_do_not_block_shutdown(self):
        release = threading.Event()
        with Collector(
            lambda body, index: (release.wait(2), accepted(body))[1]
        ) as server:
            recorder = server.recorder(request_timeout_ms=10)
            self.record(recorder)
            start = time.monotonic()
            self.assertFalse(recorder.shutdown(1000))
            self.assertLess(time.monotonic() - start, 0.8)
            self.assertEqual(len(server.bodies), 3)
            self.assertEqual(recorder.counters()["dropped"], 1)
            release.set()

    @unittest.skipUnless(hasattr(os, "fork"), "fork unavailable")
    def test_inherited_shutdown_does_not_disrupt_parent_active_socket(self):
        release = threading.Event()
        with Collector(
            lambda body, index: (release.wait(3), accepted(body))[1]
        ) as server:
            recorder = server.recorder(batch_size=1)
            self.record(recorder)
            self.assertTrue(server.received.wait(1))
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    category=DeprecationWarning,
                    message="This process .*multi-threaded",
                )
                pid = os.fork()
            if pid == 0:
                # The child's copy has its own, empty queue and no socket.
                os._exit(0 if recorder.shutdown(0) is True else 1)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0)
            release.set()
            self.assertTrue(recorder.shutdown(1000))
            self.assertEqual(recorder.counters()["sent"], 1)
            self.assertEqual(len(server.bodies), 1)


class LifecycleReviewTests(unittest.TestCase):
    def run_script(self, source, timeout=10):
        from helpers import run_isolated

        return run_isolated(source, timeout=timeout)

    @unittest.skipUnless(hasattr(os, "fork"), "fork unavailable")
    def test_shut_down_recorder_stays_shut_down_in_a_forked_child(self):
        with Collector() as server:
            recorder = server.recorder()
            self.assertTrue(recorder.shutdown())
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", category=DeprecationWarning)
                pid = os.fork()
            if pid == 0:
                self.record_in(recorder)
                counts = recorder.counters()
                os._exit(0 if counts["dropped_by_cause"]["after_shutdown"] == 1 else 1)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(status, 0)
            self.assertEqual(server.bodies, [])

    def record_in(self, recorder):
        recorder.journey({"type": "x", "id": "1"}).record(
            operation="received", name="in"
        )

    def test_recorders_never_used_or_dropped_leave_no_threads(self):
        with Collector() as server:
            result = self.run_script(f"""
                import gc, threading, time
                from wayscribe import create_recorder
                options = dict(endpoint={server.endpoint!r}, api_key="k",
                               service="s", environment="development")
                unused = [create_recorder(**options) for _ in range(200)]
                idle_threads = threading.active_count()
                used = []
                for _ in range(20):
                    recorder = create_recorder(**options)
                    recorder.journey({{"type": "x", "id": "1"}}).record(
                        operation="received", name="in")
                    assert recorder.flush(2000)
                    used.append(recorder)
                busy = sum(t.name == "wayscribe-sender" for t in threading.enumerate())
                del unused, used, recorder
                gc.collect()
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and any(
                        t.name == "wayscribe-sender" for t in threading.enumerate()):
                    time.sleep(0.05)
                left = sum(t.name == "wayscribe-sender" for t in threading.enumerate())
                print(idle_threads, busy, left)
            """)
        self.assertEqual(result.stdout.split(), ["1", "20", "0"])
        self.assertEqual(len(server.events()), 20)

    def test_queued_events_leave_at_interpreter_exit_within_a_bound(self):
        with Collector() as server:
            started = time.monotonic()
            self.run_script(f"""
                from wayscribe import create_recorder
                recorder = create_recorder(endpoint={server.endpoint!r}, api_key="k",
                    service="s", environment="development", flush_interval_ms=60000)
                recorder.journey({{"type": "x", "id": "1"}}).record(
                    operation="received", name="in")
            """)
            self.assertEqual(len(server.events()), 1)
            self.assertLess(time.monotonic() - started, 5)
        release = threading.Event()
        self.addCleanup(release.set)
        with Collector(
            lambda body, index: (release.wait(10), accepted(body))[1]
        ) as server:
            started = time.monotonic()
            self.run_script(f"""
                from wayscribe import create_recorder
                recorder = create_recorder(endpoint={server.endpoint!r}, api_key="k",
                    service="s", environment="development", flush_interval_ms=60000,
                    request_timeout_ms=10000)
                recorder.journey({{"type": "x", "id": "1"}}).record(
                    operation="received", name="in")
            """)
            # A collector that never answers holds exit for the exit flush's
            # one-second budget, not for the ten-second request timeout.
            self.assertLess(time.monotonic() - started, 4)
            release.set()

    def test_a_slow_on_diagnostic_never_holds_up_delivery(self):
        blocked = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)

        def slow(report):
            if report["kind"] == "transport_error":
                blocked.set()
                release.wait(10)

        def respond(body, index):
            return (503, b"") if index < 3 else accepted(body)

        with Collector(respond) as server:
            recorder = server.recorder(on_diagnostic=slow, batch_size=1)
            recorder._transport._jitter = lambda: 0
            self.record_in(recorder)
            self.assertTrue(blocked.wait(5))
            # The callback is still running; the retry is sent regardless.
            self.assertTrue(recorder._transport.flush(3000))
            self.assertEqual(recorder.counters()["sent"], 1)
            self.assertNotEqual(threading.current_thread().name, "wayscribe-sender")
            release.set()
            self.assertTrue(recorder.shutdown(3000))
