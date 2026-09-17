import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecorder } from "./recorder.js";

/**
 * Delivery order across an outage.
 *
 * While the breaker was open, every recorded event used to start a send that
 * failed at once and put its batch back at the front of the queue. Those
 * sends overlapped, so batches went back in the wrong order, and once the
 * queue was full the events kept were not the newest. After recovery the
 * server received events out of order, and old ones in place of recent ones.
 * Nothing is started while the breaker is open now.
 */

interface Run {
  received: number[];
  recorded: number;
  counters: Record<string, number>;
}

/** `perTick` numbered events every 100 ms, against an endpoint down until `upAt`. */
async function outage(options: {
  upAt: number;
  endAt: number;
  perTick: number;
  maxBufferedEvents?: number;
}): Promise<Run> {
  vi.useFakeTimers({ now: 1_000_000 });
  // Seeded jitter, so the backoff schedule is the same on every run.
  let seed = 42;
  vi.spyOn(Math, "random").mockImplementation(() => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  });
  const start = Date.now();
  const received: number[] = [];
  vi.stubGlobal("fetch", (_url: string, init: { body: string }): Promise<Response> => {
    if (Date.now() - start < options.upAt) return Promise.reject(new TypeError("fetch failed"));
    const parsed = JSON.parse(init.body) as { events: { event: { name: string } }[] };
    for (const { event } of parsed.events) received.push(Number(event.name));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: { results: parsed.events.map(() => ({ status: "accepted", eventId: "e" })) }
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );
  });

  const recorder = createRecorder({
    endpoint: "http://ingest.test",
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development",
    logDiagnostics: false,
    batchSize: 10,
    flushIntervalMs: 1_000,
    ...(options.maxBufferedEvents === undefined
      ? {}
      : { maxBufferedEvents: options.maxBufferedEvents })
  });
  const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
  let recorded = 0;
  while (Date.now() - start < options.endAt) {
    for (let index = 0; index < options.perTick; index += 1) {
      journey.record({ operation: "received", name: String(recorded) });
      recorded += 1;
    }
    await vi.advanceTimersByTimeAsync(100);
  }
  const done = recorder.shutdown({ timeoutMs: 5_000 });
  await vi.advanceTimersByTimeAsync(10_000);
  const counters = (await done) as unknown as Record<string, number>;
  return { received, recorded, counters };
}

/** The last `count` of `recorded` events, in order: `[recorded - count, recorded)`. */
const newest = (recorded: number, count: number): number[] =>
  Array.from({ length: count }, (_unused, index) => recorded - count + index);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("delivery across an outage", () => {
  it("delivers the events it keeps in the order they were recorded", async () => {
    const run = await outage({ upAt: 45_000, endAt: 90_000, perTick: 5 });
    const { sent = 0, dropped = 0, rejected = 0 } = run.counters;

    expect(run.counters["recorded"]).toBe(run.recorded);
    expect(sent + dropped + rejected).toBe(run.recorded);
    expect(dropped).toBeGreaterThan(0);
    // One unbroken run ending with the last event recorded. The recorder used
    // to deliver a few batches of it out of order after the endpoint came back.
    expect(run.received).toEqual(newest(run.recorded, sent));
  });

  it("keeps the newest events when the queue overflows during the outage", async () => {
    const run = await outage({
      upAt: 45_000,
      endAt: 90_000,
      perTick: 20,
      maxBufferedEvents: 300
    });
    const { sent = 0, dropped = 0 } = run.counters;

    expect(dropped).toBeGreaterThan(0);
    // The oldest are the ones dropped. The recorder used to deliver a batch
    // from the middle of the outage after events thousands newer were dropped.
    expect(run.received).toEqual(newest(run.recorded, sent));
  });
});
