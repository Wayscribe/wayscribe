import { describe, expect, it } from "vitest";
import { compare, describeComparison } from "../../../tests/support/timing.js";
import { createRecorder } from "./recorder.js";

/**
 * The work a wrapped call does to the payloads it captures, counted rather
 * than timed.
 *
 * Every walk capture makes over a payload lists it with `Object.keys`,
 * `Object.values` or `Object.entries`, and every measurement serialises it with
 * `JSON.stringify`. For one wrapped call those four are replaced by versions
 * that count what they hand back: keys and values listed, and characters
 * serialised. The counts are the same on any machine under any load, so the
 * limits can sit close to what the code does today.
 *
 * On 2026-09-18 a 1 KiB `transform` listed 2.6 entries for each property in
 * its input and output, and serialised 2.1 characters for each byte of them.
 * The build before the ADR-051 fix (`eac66cb`), which walked every stored
 * payload a second time, listed 4.9 and fails the first test here.
 *
 * The counts see only work done through those four built-ins. A walk written
 * as a `for...in` loop, or any other work that avoids them, is invisible to
 * them: in review, a second walk that masked every string before capture
 * stored it doubled the cost of a call and passed both this file and
 * `capture-walks.test.ts`. So the last test here also times a wrapped call
 * against a plain copy and serialisation of the same input and output, and
 * holds the ratio under 11. It used to do that on the wall clock, where it
 * read 7.2 to 8.0 on a quiet Apple M3 Pro and failed at 11.21 with the
 * machine's load average near 20, three times on 2026-09-18. It now measures
 * processor time with `tests/support/timing.ts`, which a busy machine does
 * not stretch. `bench/capture-cpu.mjs` and `bench/overhead.mjs` remain the
 * measurements for the README.
 */

/** Entries listed per property of the payloads, at most. 2.6 at 1 KiB, 4.9 before ADR-051. */
const ENTRIES_PER_PROPERTY = 3.5;
/** Characters serialised per byte of the payloads' JSON, at most. 2.1 at 1 KiB. */
const CHARACTERS_PER_BYTE = 3;
/** How much more work per unit the larger payload may take: linear work takes none. */
const GROWTH = 1.1;
/**
 * A wrapped 1 KiB transform against a plain copy and serialisation of its
 * input and output, in processor time, at most. 7.3 to 7.7 under load in
 * review; the second masking walk read 14.3 to 14.4.
 */
const RATIO_LIMIT = 11;

/** The benchmark's record, grown until its JSON is `bytes` long. */
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

/** Every own key of every object and array in the value: the size of one walk. */
function propertiesOf(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return Object.values(value).reduce<number>((sum, child) => sum + 1 + propertiesOf(child), 0);
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

function plainCapture(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(copyOf(value)), "utf8");
}

interface Work {
  /** Keys, values and entries handed out by Object.keys, Object.values and Object.entries. */
  listed: number;
  /** Characters JSON.stringify produced. */
  serialised: number;
}

/** Runs `call` with the built-in walks and the serialiser counted, and restores them. */
function metered(call: () => void): Work {
  const work: Work = { listed: 0, serialised: 0 };
  const { keys, values, entries } = Object;
  const stringify = JSON.stringify;
  const counting =
    <T>(list: (value: object) => T[]) =>
    (value: object): T[] => {
      const result = list(value);
      work.listed += result.length;
      return result;
    };
  Object.keys = counting(keys);
  Object.values = counting(values) as typeof Object.values;
  Object.entries = counting(entries) as typeof Object.entries;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>): string => {
    const result = stringify(...args) as string | undefined;
    work.serialised += result?.length ?? 0;
    return result as string;
  }) as typeof JSON.stringify;
  try {
    call();
  } finally {
    Object.keys = keys;
    Object.values = values;
    Object.entries = entries;
    JSON.stringify = stringify;
  }
  return work;
}

interface Measured {
  /** Entries listed per property of the input and output. */
  perProperty: number;
  /** Characters serialised per byte of the input's and output's JSON. */
  perByte: number;
}

/** The work of one wrapped `transform` of a record whose JSON is `bytes` long. */
async function transformOf(bytes: number): Promise<Measured> {
  const input = payloadOf(bytes);
  // Built before the call, so the transform itself lists and serialises nothing.
  const output = { ...payloadOf(bytes), mapped: true };
  const recorder = createRecorder({
    // Refuses connections; nothing here depends on delivery.
    endpoint: "http://127.0.0.1:1",
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development",
    logDiagnostics: false,
    flushIntervalMs: 3_600_000,
    // Large enough that no size here is omitted, which would skip the work.
    maxEventBytes: 4 * 1_024 * 1_024
  });
  try {
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    // Once for anything done on first use, then counted.
    journey.transform("map", input, () => output);
    const work = metered(() => journey.transform("map", input, () => output));
    return {
      perProperty: work.listed / (propertiesOf(input) + propertiesOf(output)),
      perByte: work.serialised / (JSON.stringify(input).length + JSON.stringify(output).length)
    };
  } finally {
    await recorder.shutdown({ timeoutMs: 50 });
  }
}

describe("the work a wrapped call does to its payloads", () => {
  it(`walks a 1 KiB input and output at most ${String(ENTRIES_PER_PROPERTY)} entries a property and serialises them at most ${String(CHARACTERS_PER_BYTE)} times`, async () => {
    const work = await transformOf(1_024);
    expect(work.perProperty, "entries listed per property").toBeLessThanOrEqual(
      ENTRIES_PER_PROPERTY
    );
    expect(work.perByte, "characters serialised per byte").toBeLessThanOrEqual(CHARACTERS_PER_BYTE);
  });

  it("does work in proportion to a payload's size, from 8 KiB to 64 KiB", async () => {
    // A walk that became quadratic, such as one that serialised each subtree
    // again, does more work per unit at eight times the size.
    const small = await transformOf(8 * 1_024);
    const large = await transformOf(64 * 1_024);
    expect(large.perProperty, "entries listed per property").toBeLessThanOrEqual(
      small.perProperty * GROWTH
    );
    expect(large.perByte, "characters serialised per byte").toBeLessThanOrEqual(
      small.perByte * GROWTH
    );
  });

  it(`costs at most ${String(RATIO_LIMIT)} times a plain copy of its input and output, in processor time`, async () => {
    const payload = payloadOf(1_024);
    const transform = (): Record<string, unknown> => ({ ...payload, mapped: true });
    const recorder = createRecorder({
      // Refuses connections; what is timed is capture, not the network.
      endpoint: "http://127.0.0.1:1",
      apiKey: "wsk_test",
      serviceName: "svc",
      environment: "development",
      logDiagnostics: false,
      flushIntervalMs: 3_600_000,
      // Every timed call is captured and kept, never dropped for a full queue.
      maxBufferedEvents: 1_000_000
    });
    try {
      const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
      const measured = compare(
        {
          run: () => {
            journey.transform("map", payload, transform);
          },
          units: 1
        },
        {
          // A transform captures its input and its output.
          run: () => {
            plainCapture(payload);
            plainCapture(transform());
          },
          units: 1
        },
        RATIO_LIMIT
      );
      expect(measured.ratio, describeComparison(measured)).toBeLessThanOrEqual(RATIO_LIMIT);
    } finally {
      await recorder.shutdown({ timeoutMs: 50 });
    }
  });
});
