import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createDiagnostics, type Diagnostic, type DroppedDiagnostic } from "./diagnostics.js";
import { createRecorder, type Counters, type DroppedCause, type Recorder } from "./index.js";

/**
 * `dropped` by cause, and a collector that answers without verdicts opening
 * the breaker (F-048, ADR-063 decision 3).
 *
 * Four different faults used to end with the same line, `recorded 12, sent 0,
 * rejected 0, dropped 12`, and a proxy answering 2xx with the wrong body lost
 * every event without the breaker opening: `recorded 16000, dropped 16000`.
 */

const CAUSES = ["queue_full", "after_shutdown", "shutdown", "retry_budget", "no_verdict"] as const;

const zero = Object.fromEntries(CAUSES.map((cause) => [cause, 0]));

function dropped(code: DroppedDiagnostic["code"]): DroppedDiagnostic {
  return { kind: "dropped", code, reason: "r", detail: {} };
}

function sum(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce((total, count) => total + count, 0);
}

describe("droppedByCause", () => {
  it("has every cause at zero from creation", () => {
    expect(createDiagnostics().counters().droppedByCause).toEqual(zero);
  });

  it("names exactly the dropped diagnostic's codes", () => {
    expectTypeOf<DroppedCause>().toEqualTypeOf<DroppedDiagnostic["code"]>();
    expectTypeOf<Counters["droppedByCause"]>().toEqualTypeOf<
      Readonly<Record<DroppedCause, number>>
    >();
  });

  it("counts each dropped report under its code, and dropped is always their sum", () => {
    const diagnostics = createDiagnostics();
    const reports: DroppedDiagnostic["code"][] = [
      "queue_full",
      "queue_full",
      "after_shutdown",
      "shutdown",
      "retry_budget",
      "no_verdict",
      "no_verdict",
      "no_verdict"
    ];
    for (const code of reports) {
      diagnostics.report(dropped(code));
      const counters = diagnostics.counters();
      expect(counters.dropped).toBe(sum(counters.droppedByCause));
    }
    // Other kinds leave it alone.
    diagnostics.report({
      kind: "breaker_opened",
      code: "consecutive_failures",
      reason: "r",
      detail: { failures: 5, cooldownMs: 1 }
    });
    diagnostics.recordSent(3);
    expect(diagnostics.counters().droppedByCause).toEqual({
      queue_full: 2,
      after_shutdown: 1,
      shutdown: 1,
      retry_budget: 1,
      no_verdict: 3
    });
    expect(diagnostics.counters().dropped).toBe(8);
  });

  it("is a fresh copy on every read", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report(dropped("shutdown"));
    const first = diagnostics.counters();
    (first.droppedByCause as Record<string, number>)["shutdown"] = 99;
    const second = diagnostics.counters();
    expect(second.droppedByCause).not.toBe(first.droppedByCause);
    expect(second.droppedByCause.shutdown).toBe(1);
    diagnostics.report(dropped("shutdown"));
    expect(second.droppedByCause.shutdown).toBe(1);
    expect(diagnostics.counters().droppedByCause.shutdown).toBe(2);
  });
});

/** A collector that answers every request with `reply`, counting requests and events. */
async function collector(
  reply: (events: number, response: ServerResponse) => void
): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((incoming: IncomingMessage, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body) as { events: unknown[] };
      reply(parsed.events.length, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      })
  };
}

function recorderFor(endpoint: string, diagnostics: Diagnostic[]): Recorder {
  return createRecorder({
    endpoint,
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development",
    batchSize: 10,
    maxConcurrentSends: 1,
    flushIntervalMs: 3_600_000,
    maxBufferedEvents: 10_000,
    onDiagnostic: (d) => diagnostics.push(d)
  });
}

/** 200 events in 20 flushed batches of 10, then shutdown. */
async function run(recorder: Recorder): Promise<Counters> {
  const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
  for (let batch = 0; batch < 20; batch += 1) {
    for (let i = 0; i < 10; i += 1)
      journey.record({ operation: "received", name: `e${String(i)}` });
    await recorder.flush();
  }
  await recorder.shutdown({ timeoutMs: 2_000 });
  return recorder.counters();
}

describe("a collector that answers 2xx without verdicts (F-048)", () => {
  it.each([
    [
      "a 202 whose body is not JSON",
      (_events: number, response: ServerResponse) => {
        response.writeHead(202, { "content-type": "text/plain" });
        response.end("accepted");
      }
    ],
    [
      "a 200 whose JSON is not a verdict",
      (_events: number, response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      }
    ],
    [
      "a 202 whose results are none of them verdicts",
      (events: number, response: ServerResponse) => {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: { results: Array.from({ length: events }, () => ({ status: "queued" })) }
          })
        );
      }
    ]
  ])("opens the breaker after five sends: %s", async (_what, reply) => {
    const stub = await collector(reply);
    const diagnostics: Diagnostic[] = [];
    try {
      const counters = await run(recorderFor(stub.url, diagnostics));
      // Five sends reached the collector, then the breaker held the rest.
      expect(stub.requests()).toBe(5);
      expect(counters.breakerOpened).toBe(1);
      expect(counters.transportErrors).toBe(0);
      expect(counters.recorded).toBe(200);
      expect(counters.sent).toBe(0);
      expect(counters.droppedByCause).toEqual({ ...zero, no_verdict: 50, shutdown: 150 });
      expect(counters.dropped).toBe(sum(counters.droppedByCause));
      expect(counters.sent + counters.rejected + counters.dropped).toBe(counters.recorded);
    } finally {
      await stub.close();
    }
  });

  it("keeps sending to a server that answers some events, as before", async () => {
    // Half the verdicts: a server speaking the protocol badly, which resets.
    const stub = await collector((events, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            results: Array.from({ length: Math.floor(events / 2) }, () => ({
              status: "rejected",
              error: { code: "invalid_event", message: "m", httpStatus: 400 }
            }))
          }
        })
      );
    });
    const diagnostics: Diagnostic[] = [];
    try {
      const counters = await run(recorderFor(stub.url, diagnostics));
      expect(stub.requests()).toBe(20);
      expect(counters.breakerOpened).toBe(0);
      expect(counters.rejected).toBe(100);
      expect(counters.droppedByCause).toEqual({ ...zero, no_verdict: 100 });
      expect(counters.sent + counters.rejected + counters.dropped).toBe(counters.recorded);
    } finally {
      await stub.close();
    }
  });
});

describe("the causes read apart at the recorder", () => {
  it("names queue_full, after_shutdown and shutdown for what each is", async () => {
    // Nothing listens on port 1: every send fails, so events queue and shed.
    const diagnostics: Diagnostic[] = [];
    const recorder = createRecorder({
      endpoint: "http://127.0.0.1:1",
      apiKey: "wsk_test",
      serviceName: "svc",
      environment: "development",
      flushIntervalMs: 3_600_000,
      batchSize: 100,
      maxBufferedEvents: 5,
      onDiagnostic: (d) => diagnostics.push(d)
    });
    const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
    for (let i = 0; i < 8; i += 1) journey.record({ operation: "received", name: "r" });
    await recorder.shutdown({ timeoutMs: 200 });
    journey.record({ operation: "received", name: "late" });
    const counters = recorder.counters();
    expect(counters.droppedByCause).toEqual({
      ...zero,
      queue_full: 3,
      shutdown: 5,
      after_shutdown: 1
    });
    expect(counters.dropped).toBe(9);
    expect(counters.sent + counters.rejected + counters.dropped).toBe(counters.recorded);
  });
});
