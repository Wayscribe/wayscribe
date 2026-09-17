import { Worker } from "node:worker_threads";

/**
 * Preloaded into a scenario process by `overhead.mjs --awake`: a thread that
 * wakes every 100 microseconds and does nothing else.
 *
 * The latency scenario makes a call, then sleeps until the next one is due. On
 * a laptop the cores go idle in between, and a call that starts on an idle core
 * runs about three times slower than the same call on a busy one: on an Apple
 * M3 Pro on 2026-09-16 a wrapped 1 KiB `transform` took 114 µs at p50 with the
 * cores idle and 40 µs with this thread running. A service under load keeps its
 * cores awake, so this is the closer estimate of what the SDK costs one; the
 * default run is the closer estimate for a service that is mostly idle.
 *
 * `--cpu-prof` has the same effect through its sampling thread, so a profile of
 * the latency scenario shows the fast case whether or not this is loaded.
 */
const spinner = new Worker(
  `const cell = new Int32Array(new SharedArrayBuffer(4));
   for (;;) Atomics.wait(cell, 0, 0, 0.1);`,
  { eval: true }
);
spinner.unref();
