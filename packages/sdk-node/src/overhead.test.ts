import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

/**
 * A tripwire for a gross slowdown of a wrapped call, not a regression detector.
 *
 * Times a wrapped `transform` of a 1 KiB record against a plain copy and
 * serialisation of its input and output, in this process, interleaved, and
 * compares the fastest of many short runs of each. Microseconds depend on the
 * machine and on what it is doing; the ratio moves less, but not little enough
 * to separate a 40 percent regression from noise. On an Apple M3 Pro on
 * 2026-09-16 it read 7.2 to 8.0 with the capture fix, and 9.31 to 10.05 on the
 * build before it (`eac66cb`), where most runs stayed under 9.5. The limit is
 * therefore well above both, and catches only something like a walk that
 * became quadratic or a payload serialised many times over.
 *
 * The regression that fix removed is held by `capture-walks.test.ts`, which
 * counts the calls instead. `bench/overhead.mjs` and `bench/capture-cpu.mjs`
 * are the measurements for the README.
 */

const RUNS = 41;
const CALLS_PER_RUN = 100;
const WARMUP_CALLS = 2_000;
const RATIO_LIMIT = 11;

/** The benchmark's record, grown until its JSON is 1 KiB. */
function payloadOf(bytes: number): Record<string, unknown> {
  const items: Record<string, unknown>[] = [];
  const payload: Record<string, unknown> = {
    Id: "ACCT-9001",
    Name: "Dana Whitfield",
    Phone: "+1 617 555 0148",
    Status__c: "Active",
    items
  };
  while (JSON.stringify(payload).length < bytes) {
    const index = items.length;
    items.push({
      sku: `SKU-${String(index).padStart(6, "0")}`,
      description: "Replacement filter cartridge, pack of two",
      quantity: (index % 7) + 1,
      unitPriceCents: 1999 + index,
      tags: ["filters", "consumables"]
    });
  }
  return payload;
}

/**
 * The least any capture does to a payload it keeps: walk it into a copy the
 * caller cannot change, look at every key, and measure it.
 */
function copyOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(copyOf);
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "password") continue;
    copy[key] = copyOf(child);
  }
  return copy;
}

function referenceCapture(value: unknown): number {
  const copy = copyOf(value);
  return Buffer.byteLength(JSON.stringify(copy), "utf8");
}

function perCall(call: () => unknown): number {
  const started = performance.now();
  for (let index = 0; index < CALLS_PER_RUN; index += 1) call();
  return (performance.now() - started) / CALLS_PER_RUN;
}

describe("the cost of a wrapped call", () => {
  it("stays within a generous multiple of a plain capture of its input and output", async () => {
    const payload = payloadOf(1_024);
    const transform = (): Record<string, unknown> => ({ ...payload, mapped: true });
    const recorder = createRecorder({
      // Refuses connections; what is timed is capture, not the network.
      endpoint: "http://127.0.0.1:1",
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development",
      logDiagnostics: false,
      flushIntervalMs: 3_600_000,
      maxBufferedEvents: WARMUP_CALLS + RUNS * CALLS_PER_RUN
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    const wrapped = (): unknown => journey.transform("map", payload, transform);
    // A transform captures its input and its output.
    const reference = (): unknown => referenceCapture(payload) + referenceCapture(transform());

    try {
      for (let index = 0; index < WARMUP_CALLS; index += 1) {
        wrapped();
        reference();
      }
      // Interleaved, and the fastest run of each kept: a run the machine
      // interrupted, or spent on a slower core, is only ever slower, so the
      // fastest is the closest estimate of the work itself.
      let recorded = Number.POSITIVE_INFINITY;
      let plain = Number.POSITIVE_INFINITY;
      for (let run = 0; run < RUNS; run += 1) {
        recorded = Math.min(recorded, perCall(wrapped));
        plain = Math.min(plain, perCall(reference));
      }

      const ratio = recorded / plain;
      expect(
        ratio,
        `wrapped transform ${(recorded * 1_000).toFixed(1)} µs, reference ${(plain * 1_000).toFixed(1)} µs, ratio ${ratio.toFixed(2)}`
      ).toBeLessThan(RATIO_LIMIT);
    } finally {
      await recorder.shutdown({ timeoutMs: 50 });
    }
  });
});
