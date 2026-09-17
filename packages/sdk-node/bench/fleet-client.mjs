import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout } from "node:timers";

/**
 * One SDK process producing events at a base rate, multiplied during a burst,
 * then shutting down and reporting its counters to `fleet.mjs`.
 */
const args = JSON.parse(process.argv[2] ?? "{}");
const { createRecorder } = await import(args.module);

const recorder = createRecorder({
  endpoint: args.endpoint,
  apiKey: "wsk_bench_not_a_key",
  serviceName: "fleet",
  environment: "bench",
  maxConcurrentSends: args.maxConcurrentSends
});
const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
const input = { note: "x".repeat(400) };

const started = performance.now();
let produced = 0;
let credit = 0;
let last = started;
while (performance.now() - started < args.seconds * 1_000) {
  const now = performance.now();
  const elapsed = (now - started) / 1_000;
  const bursting = elapsed >= args.burstStart && elapsed < args.burstStart + args.burstSeconds;
  credit += ((now - last) / 1_000) * args.rate * (bursting ? args.burstFactor : 1);
  last = now;
  while (credit >= 1) {
    journey.record({ operation: "received", name: "fleet-event", input });
    produced += 1;
    credit -= 1;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

const counters = await recorder.shutdown({ timeoutMs: 2_000 });
process.send?.({ type: "done", produced, counters }, () => {
  process.exit(0);
});
