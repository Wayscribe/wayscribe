import { performance } from "node:perf_hooks";
import process from "node:process";
import { buildRecorder } from "./build.mjs";

/**
 * The processor time a wrapped call spends, with no pacing and no network.
 *
 *   pnpm --filter @wayscribe/node exec node bench/capture-cpu.mjs
 *   pnpm --filter @wayscribe/node exec node bench/capture-cpu.mjs --module=/path/to/other-build.mjs
 *
 * `overhead.mjs` paces its calls, so what it reports depends on whether the
 * cores were idle before each call (see awake.mjs). This calls the wrappers in
 * a loop instead, which keeps a core busy, and reports the median of seven runs
 * in microseconds per call. It is the number to compare between two builds;
 * `--module` measures a bundle built elsewhere, such as one from an earlier
 * commit, with the same loop.
 *
 * The recorder points at a port nothing listens on, with a flush interval
 * longer than the run and a buffer larger than it, so the time is capture and
 * the queue push. The `persist` callback returns synchronously, so no promise
 * turn is counted either. Not part of `pnpm test`: the numbers depend on the
 * machine, and `src/overhead.test.ts` holds the ratio instead.
 */
const RUNS = 7;

/** The same record `scenario.mjs` uses, grown until its JSON is `bytes` long. */
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

async function perCall(createRecorder, wrapper, payload, count) {
  const recorder = createRecorder({
    endpoint: "http://127.0.0.1:1",
    apiKey: "fr_bench_not_a_key",
    serviceName: "bench",
    environment: "bench",
    flushIntervalMs: 3_600_000,
    maxBufferedEvents: count + 10,
    logDiagnostics: false
  });
  const journey = recorder.startJourney({ entity: { type: "customer", id: payload.Id } });
  const transform = () => ({ ...payload, mapped: true });
  const persist = () => ({ id: 4471 });
  const call =
    wrapper === "transform"
      ? () => journey.transform("map-account-to-customer", payload, transform)
      : () => journey.persist("save-customer", payload, persist);
  const started = performance.now();
  for (let index = 0; index < count; index += 1) call();
  const elapsed = performance.now() - started;
  await recorder.shutdown({ timeoutMs: 20 });
  return (elapsed * 1_000) / count;
}

async function median(createRecorder, wrapper, bytes) {
  const payload = payloadOf(bytes);
  const count = bytes > 1_024 ? 1_000 : 20_000;
  await perCall(createRecorder, wrapper, payload, count / 2);
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) {
    runs.push(await perCall(createRecorder, wrapper, payload, count));
  }
  runs.sort((left, right) => left - right);
  return runs[Math.floor(RUNS / 2)];
}

const given = process.argv.find((argument) => argument.startsWith("--module="));
const built = given === undefined ? await buildRecorder() : undefined;
try {
  const moduleUrl = built?.module ?? new URL(given.slice("--module=".length), "file:///").href;
  const { createRecorder } = await import(moduleUrl);
  const rows = [];
  for (const wrapper of ["transform", "persist"]) {
    for (const bytes of [1_024, 65_536]) {
      const microseconds = await median(createRecorder, wrapper, bytes);
      rows.push(
        `| \`${wrapper}\` | ${bytes > 1_024 ? "64 KiB" : "1 KiB"} | ${microseconds.toFixed(1)} |`
      );
    }
  }
  process.stdout.write(
    [
      `Node ${process.version}; median of ${String(RUNS)} runs, microseconds per call`,
      "",
      "| Wrapper | Payload | Per call |",
      "| --- | --- | --- |",
      ...rows,
      ""
    ].join("\n")
  );
} finally {
  built?.remove();
}
