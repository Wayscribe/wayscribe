import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecorder } from "./recorder.js";

const base = {
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "development"
};

type Verdict = (name: string, attempt: number) => unknown;

const accepted = { status: "accepted", eventId: "evt" };
const refused = (httpStatus: number, code: string): unknown => ({
  eventId: null,
  status: "rejected",
  error: { code, message: `refused with ${String(httpStatus)}`, httpStatus }
});

/**
 * A batch route that decides per event, by name and by how many times it has
 * seen that event, and remembers every name it was sent in order.
 */
async function ingestion(verdict: Verdict): Promise<{
  endpoint: string;
  received: string[];
  close: () => Promise<void>;
}> {
  const received: string[] = [];
  const attempts = new Map<string, number>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { events: { event: { name: string } }[] };
      const results = parsed.events.map(({ event }) => {
        const attempt = (attempts.get(event.name) ?? 0) + 1;
        attempts.set(event.name, attempt);
        received.push(event.name);
        return verdict(event.name, attempt);
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { results } }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      })
  };
}

async function recordNamed(
  endpoint: string,
  names: readonly string[],
  seen: string[] = []
): Promise<ReturnType<ReturnType<typeof createRecorder>["counters"]>> {
  const recorder = createRecorder({
    ...base,
    endpoint,
    batchSize: names.length,
    onDiagnostic: (d) => seen.push(`${d.kind}|${d.reason}`)
  });
  const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
  for (const name of names) journey.record({ operation: "received", name });
  return recorder.shutdown({ timeoutMs: 5_000 });
}

const count = (list: readonly string[], name: string): number =>
  list.filter((item) => item === name).length;

describe("a per-event refusal the server may not repeat", () => {
  it("retries a 500 storage_error and stores the event", async () => {
    const server = await ingestion((_name, attempt) =>
      attempt === 1 ? refused(500, "storage_error") : accepted
    );
    const counters = await recordNamed(server.endpoint, ["n"]);
    await server.close();

    expect(count(server.received, "n")).toBe(2);
    expect(counters).toMatchObject({ sent: 1, rejected: 0, transportErrors: 0, dropped: 0 });
  });

  it("does not retry a 422", async () => {
    const server = await ingestion(() => refused(422, "invalid_event"));
    const counters = await recordNamed(server.endpoint, ["n"]);
    await server.close();

    expect(count(server.received, "n")).toBe(1);
    expect(counters).toMatchObject({ sent: 0, rejected: 1, transportErrors: 0, dropped: 0 });
  });

  it("resends only the transient refusals from a mixed batch", async () => {
    const server = await ingestion((name, attempt) => {
      if (name === "bad") return refused(400, "invalid_event");
      if (name === "busy" && attempt === 1) return refused(503, "query_timeout");
      if (name === "broken" && attempt < 3) return refused(500, "storage_error");
      return accepted;
    });
    const counters = await recordNamed(server.endpoint, ["ok1", "busy", "bad", "broken", "ok2"]);
    await server.close();

    expect(server.received).toEqual([
      "ok1",
      "busy",
      "bad",
      "broken",
      "ok2",
      "busy",
      "broken",
      "broken"
    ]);
    expect(counters).toMatchObject({ sent: 4, rejected: 1, transportErrors: 0, dropped: 0 });
  });
});

describe("a refusal that lasts, on a clock", () => {
  /**
   * `fetch` replaced by a batch route that decides by event name and the
   * current (fake) time, so seconds of outage run in milliseconds.
   */
  function fakeIngestion(verdict: (name: string, now: number) => unknown): {
    sent: string[];
  } {
    const sent: string[] = [];
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      const { events } = JSON.parse(init.body) as { events: { event: { name: string } }[] };
      const results = events.map(({ event }) => {
        sent.push(event.name);
        return verdict(event.name, Date.now());
      });
      return Promise.resolve(
        new Response(JSON.stringify({ data: { results } }), {
          status: 202,
          headers: { "content-type": "application/json" }
        })
      );
    });
    return { sent };
  }

  const START = 1_000_000;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stores an event refused with 500 for five seconds", async () => {
    // A database restart. Three refusals inside 300 ms of backoff used to drop
    // this event while the CHANGELOG said it was retried.
    const { sent } = fakeIngestion((_name, now) =>
      now - START < 5_000 ? refused(500, "storage_error") : accepted
    );
    const recorder = createRecorder({ ...base, endpoint: "http://ingest.test", batchSize: 1 });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(recorder.counters()).toMatchObject({ sent: 1, dropped: 0, rejected: 0 });
    // More than the three refusals that used to be the whole budget.
    expect(count(sent, "n")).toBeGreaterThan(3);
  });

  it("drops an event refused for thirty seconds by its time budget, and not before", async () => {
    // The breaker must not be what holds this event back, or the test proves
    // the breaker's cooldown rather than the budget. So every send also stores
    // an event, which keeps the breaker closed, and sends are four seconds
    // apart, so the ten-send cap is not reached first either: the poison is
    // first refused at 4 s, requeued at 32 s (28 s refused, eighth send), and
    // given up at 36 s (32 s refused, ninth send).
    const seen: string[] = [];
    const { sent } = fakeIngestion((name) =>
      name === "poison" ? refused(503, "query_timeout") : accepted
    );
    const recorder = createRecorder({
      ...base,
      endpoint: "http://ingest.test",
      flushIntervalMs: 4_000,
      onDiagnostic: (d) => seen.push(`${d.kind}|${d.reason}`)
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    journey.record({ operation: "received", name: "poison" });
    journey.record({ operation: "received", name: "ok" });

    /** Moves the clock to `seconds` past the start, recording one event every 4 s. */
    async function until(seconds: number): Promise<void> {
      while (Date.now() - START < seconds * 1_000) {
        const step = Math.min(
          4_000 - ((Date.now() - START) % 4_000),
          seconds * 1_000 - (Date.now() - START)
        );
        await vi.advanceTimersByTimeAsync(step);
        if ((Date.now() - START) % 4_000 === 0) {
          journey.record({ operation: "received", name: "ok" });
        }
      }
    }

    // Past the eighth send, at 32 s, and its retries: refused for 28 s.
    await until(35);
    expect(recorder.counters()).toMatchObject({ dropped: 0, breakerOpened: 0 });

    // The ninth send, at 36 s: refused for 32 s, so given up on.
    await until(37);
    expect(recorder.counters()).toMatchObject({ dropped: 1, rejected: 0, breakerOpened: 0 });
    expect(seen.some((line) => line.startsWith("dropped|") && line.includes("30 seconds"))).toBe(
      true
    );
    // Three attempts in each of eight sends and one in the ninth: under the
    // ten-send cap, so the time budget is what ended it.
    expect(count(sent, "poison")).toBe(25);

    // Given up means given up: nothing more is sent for it.
    await until(60);
    expect(count(sent, "poison")).toBe(25);
  });

  it("does not slow a steady stream while one event in it is refused", async () => {
    async function stream(withPoison: boolean): Promise<{ stored: number; dropped: number }> {
      let stored = 0;
      fakeIngestion((name) => {
        if (name === "poison") return refused(500, "storage_error");
        stored += 1;
        return accepted;
      });
      const recorder = createRecorder({ ...base, endpoint: "http://ingest.test" });
      const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
      if (withPoison) journey.record({ operation: "received", name: "poison" });
      // 200 events a second for 40 seconds, in steps of 100 ms.
      for (let step = 0; step < 400; step += 1) {
        for (let i = 0; i < 20; i += 1) journey.record({ operation: "received", name: "ok" });
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(5_000);
      const counters = recorder.counters();
      vi.unstubAllGlobals();
      return { stored, dropped: counters.dropped };
    }

    const clean = await stream(false);
    const poisoned = await stream(true);

    expect(clean).toEqual({ stored: 8_000, dropped: 0 });
    // Every other event still stored, and the poison given up on by its bounds.
    expect(poisoned).toEqual({ stored: 8_000, dropped: 1 });
  });
});
