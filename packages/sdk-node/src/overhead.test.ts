import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

/**
 * What a wrapped call costs, held relative to plain work in the same process.
 *
 * The SDK's benchmark (`bench/overhead.mjs`) measures microseconds, which
 * depend on the machine and on what it is doing: one build measured 30 µs at
 * p50 for a 1 KiB `transform` on 2026-09-15 and 85 µs on 2026-09-16 on the
 * same laptop, and the current build 114 µs with its cores idle between calls
 * and 40 µs with one kept awake. A limit in microseconds would either fail on a
 * busy CI runner or pass anything. This test times a wrapped `transform` of a
 * 1 KiB record against a plain capture written in the test, in this process,
 * interleaved, and compares the fastest of many short runs of each. A run the
 * machine interrupted, or spent on a slower core, is only ever slower, so the
 * fastest is the closest estimate of the work; and both sides are JavaScript
 * walking the same objects, so their ratio moves far less than either time.
 *
 * Measured on 2026-09-16 (Apple M3 Pro, Node 24.19.0 and 22.23.1): 7.2 to 8.0,
 * including with eleven of twelve cores kept busy. Before the fix that added
 * this test it was 9.55 to 9.99: the event budget check (ADR-051) and a second
 * walk to cut strings had made a 1 KiB `transform` about 40 percent slower. The
 * same comparison on a bundle gave the same ratios within 5 percent on Alpine
 * arm64 and emulated x64. A regression of that size fails here.
 */

const RUNS = 41;
const CALLS_PER_RUN = 100;
const WARMUP_CALLS = 2_000;
const RATIO_LIMIT = 9.5;

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
  it("stays within a fixed multiple of a plain capture of its input and output", async () => {
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
