import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";
import { setImmediate, setTimeout } from "node:timers";

/**
 * One measurement, in a fresh process so heap, JIT state, and sockets from one
 * scenario never colour the next. Started by `overhead.mjs` with its arguments
 * as JSON, and replies with its result over IPC.
 */
const args = JSON.parse(process.argv[2] ?? "{}");
const { createRecorder } = await import(args.module);

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A customer record with line items, grown until its JSON is `bytes` long. */
function payloadOf(bytes) {
  const payload = {
    Id: "ACCT-9001",
    Name: "Dana Whitfield",
    Phone: "+1 617 555 0148",
    Status__c: "Active",
    items: []
  };
  while (JSON.stringify(payload).length < bytes) {
    const i = payload.items.length;
    payload.items.push({
      sku: `SKU-${String(i).padStart(6, "0")}`,
      description: "Replacement filter cartridge, pack of two",
      quantity: (i % 7) + 1,
      unitPriceCents: 1999 + i,
      tags: ["filters", "consumables"]
    });
  }
  return payload;
}

function recorderFor(endpoint, extra = {}) {
  return createRecorder({
    endpoint,
    apiKey: "fr_bench_not_a_key",
    serviceName: "bench",
    environment: "bench",
    ...extra
  });
}

/**
 * The histogram records the whole interval between its timer's callbacks, so
 * an idle loop reads as the resolution itself. Reported as the delay beyond it.
 */
const LOOP_RESOLUTION_MS = 10;
const beyondResolution = (nanoseconds) => Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Runs `call` `count` times at `rate` calls per second, timing each call to the
 * nanosecond, including the wait for its promise when it returns one.
 *
 * Paced rather than flat out: a service does not call a wrapper a million times
 * a second, and the recorder does its sending between calls, so a tight loop
 * would measure a queue that is always full and a transport that never runs.
 */
async function paced(call, { count, rate, onEach }) {
  const samples = new Float64Array(count);
  const started = performance.now();
  let done = 0;
  while (done < count) {
    const due = Math.min(count, Math.floor(((performance.now() - started) / 1000) * rate) + 1);
    while (done < due) {
      const start = process.hrtime.bigint();
      const result = call(done);
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        await result;
      }
      samples[done] = Number(process.hrtime.bigint() - start);
      onEach?.(done);
      done += 1;
    }
    await sleep(1);
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  return { samples: Array.from(samples).sort((a, b) => a - b), elapsedSeconds };
}

function summary(sorted) {
  return {
    p50: percentile(sorted, 50) / 1e3,
    p99: percentile(sorted, 99) / 1e3,
    max: (sorted.at(-1) ?? 0) / 1e3
  };
}

async function latency() {
  const payload = payloadOf(args.bytes);
  const transform = () => ({ ...payload, mapped: true });
  const persist = () => Promise.resolve({ id: 4471 });
  const fn = args.wrapper === "sync" ? transform : persist;
  const options = { count: args.calls, rate: args.rate };

  // Warm both paths first, so JIT compilation is not counted against either.
  await paced(fn, { count: args.warmup, rate: args.rate * 4 });
  const baseline = await paced(fn, options);

  const recorder = recorderFor(args.endpoint);
  const journey = recorder.startJourney({ entity: { type: "customer", id: payload.Id } });
  const wrapped =
    args.wrapper === "sync"
      ? () => journey.transform("map-account-to-customer", payload, transform)
      : () => journey.persist("save-customer", payload, persist);
  await paced(wrapped, { count: args.warmup, rate: args.rate * 4 });
  const measured = await paced(wrapped, options);
  // Long enough to drain against the 200 ms stub, so `sent` is what was stored.
  const counters = await recorder.shutdown({ timeoutMs: 10_000 });

  return {
    baseline: summary(baseline.samples),
    wrapped: summary(measured.samples),
    counters
  };
}

/**
 * The same schedule with and without the recorder, so the harness's own cost
 * (pacing timers, payload building) is visible and subtracted by eye.
 */
async function sustained() {
  const payload = payloadOf(args.bytes);
  const transform = () => ({ ...payload, mapped: true });
  const persist = () => Promise.resolve({ id: 4471 });

  let recorder;
  let call = (i) => (i % 2 === 0 ? transform() : persist());
  if (args.wrapped) {
    recorder = recorderFor(args.endpoint);
    const journey = recorder.startJourney({ entity: { type: "customer", id: payload.Id } });
    call = (i) =>
      i % 2 === 0
        ? journey.transform("map-account-to-customer", payload, transform)
        : journey.persist("save-customer", payload, persist);
  }

  // Two seconds of warm-up at the target rate, so the heap has reached its
  // working size before the baseline reading.
  await paced(call, { count: args.rate * 2, rate: args.rate });
  globalThis.gc?.();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const heapStart = process.memoryUsage().heapUsed;

  const delay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  delay.enable();
  let heapPeak = heapStart;
  const samplesPerSecond = args.rate;
  const run = await paced(call, {
    count: args.rate * args.seconds,
    rate: args.rate,
    onEach: (i) => {
      if (i % samplesPerSecond === 0) {
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }
    }
  });
  delay.disable();

  globalThis.gc?.();
  const heapEnd = process.memoryUsage().heapUsed;
  const counters =
    recorder === undefined ? undefined : await recorder.shutdown({ timeoutMs: 2_000 });

  return {
    achievedRate: (args.rate * args.seconds) / run.elapsedSeconds,
    heapStartMiB: heapStart / 2 ** 20,
    heapEndMiB: heapEnd / 2 ** 20,
    heapPeakMiB: heapPeak / 2 ** 20,
    rssMiB: process.memoryUsage().rss / 2 ** 20,
    loopDelayMs: {
      p50: beyondResolution(delay.percentile(50)),
      p99: beyondResolution(delay.percentile(99)),
      max: beyondResolution(delay.max)
    },
    counters
  };
}

/**
 * Events produced at a fixed rate against a server with a fixed latency.
 * Throughput is what the server had stored by the end of the production
 * window, not what a final drain delivers afterwards, because a backlog that
 * only clears at shutdown is a backlog a running service carries forever.
 */
async function concurrency() {
  const payload = payloadOf(args.bytes);
  const recorder = recorderFor(args.endpoint);
  const journey = recorder.startJourney({ entity: { type: "customer", id: payload.Id } });
  const delay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  delay.enable();
  const run = await paced(
    () => {
      journey.record({ operation: "received", name: "receive-account-webhook", input: payload });
    },
    { count: args.rate * args.seconds, rate: args.rate }
  );
  delay.disable();
  const inWindow = await args.stats();
  const counters = await recorder.shutdown({ timeoutMs: 10_000 });
  return {
    produced: args.rate * args.seconds,
    elapsedSeconds: run.elapsedSeconds,
    storedInWindow: inWindow.accepted,
    throughput: inWindow.accepted / run.elapsedSeconds,
    peakInFlight: inWindow.peakInFlight,
    loopDelayP99Ms: beyondResolution(delay.percentile(99)),
    counters
  };
}

/** Asks the parent to ask the stub how much it has stored. */
args.stats = () =>
  new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== "stats") return;
      process.off("message", onMessage);
      resolve(message);
    };
    process.on("message", onMessage);
    process.send?.({ type: "stats" });
  });

const scenarios = { latency, sustained, concurrency };
const result = await scenarios[args.scenario]();
process.send?.({ type: "result", result }, () => {
  process.exit(0);
});
