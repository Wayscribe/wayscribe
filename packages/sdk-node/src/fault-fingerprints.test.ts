import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecorder, type Counters } from "./index.js";

/**
 * Telling collector faults apart from the counters (F-050).
 *
 * Under a fault that lasts, `droppedByCause` is mostly `queue_full` and
 * `shutdown` whatever the collector did, because those name where an event was
 * lost, not why. The README and TROUBLESHOOTING give the rule that does read
 * the faults apart: `no_verdict` above zero is a collector that answered
 * without a verdict, `transportErrors` above zero is one that could not be
 * used, and a collector that is only slow moves neither. These hold that rule
 * to what the recorder does.
 */

type Reply = (events: number, response: ServerResponse) => void;

interface Stub {
  url: string;
  close: () => Promise<void>;
}

async function collector(reply: Reply): Promise<Stub> {
  const server = createServer((incoming: IncomingMessage, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { events: unknown[] };
      reply(parsed.events.length, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      })
  };
}

/** An address nothing listens on: a port the system gave out and took back. */
async function refusingEndpoint(): Promise<Stub> {
  const stub = await collector(() => undefined);
  await stub.close();
  return { url: stub.url, close: () => Promise.resolve() };
}

const accepted: Reply = (events, response) => {
  response.writeHead(202, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      data: { results: Array.from({ length: events }, () => ({ status: "accepted" })) }
    })
  );
};

/**
 * A lasting fault: 200 events recorded at once into a queue of 20, so most are
 * shed before anything is answered, then shutdown.
 */
async function burst(
  endpoint: string,
  settings: { requestTimeoutMs?: number; shutdownMs: number }
): Promise<Counters> {
  const recorder = createRecorder({
    endpoint,
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development",
    batchSize: 10,
    maxConcurrentSends: 1,
    maxBufferedEvents: 20,
    flushIntervalMs: 3_600_000,
    ...(settings.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: settings.requestTimeoutMs }),
    onDiagnostic: () => undefined
  });
  const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
  for (let i = 0; i < 200; i += 1) journey.record({ operation: "received", name: `e${String(i)}` });
  return recorder.shutdown({ timeoutMs: settings.shutdownMs });
}

/** The cause with the most drops. */
function largestCause(counters: Counters): string {
  return Object.entries(counters.droppedByCause).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

let stub: Stub | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await stub?.close();
  stub = undefined;
});

describe("telling collector faults apart (F-050)", () => {
  it("reads a collector that answers without a verdict by no_verdict, with no transport error", async () => {
    stub = await collector((_events, response) => {
      response.writeHead(202, { "content-type": "text/plain" });
      response.end("accepted");
    });
    const counters = await burst(stub.url, { shutdownMs: 2_000 });
    expect(counters.droppedByCause.no_verdict).toBeGreaterThan(0);
    expect(counters.transportErrors).toBe(0);
    expect(largestCause(counters)).toBe("queue_full");
    expect(counters.sent + counters.rejected + counters.dropped).toBe(counters.recorded);
  });

  it("reads a collector that answers 500 by transportErrors, with no no_verdict", async () => {
    stub = await collector((_events, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("down");
    });
    const counters = await burst(stub.url, { shutdownMs: 2_000 });
    expect(counters.transportErrors).toBeGreaterThan(0);
    expect(counters.droppedByCause.no_verdict).toBe(0);
    expect(largestCause(counters)).toBe("queue_full");
  });

  it("reads a refused connection by transportErrors, with no no_verdict", async () => {
    stub = await refusingEndpoint();
    const counters = await burst(stub.url, { shutdownMs: 2_000 });
    expect(counters.transportErrors).toBeGreaterThan(0);
    expect(counters.droppedByCause.no_verdict).toBe(0);
    expect(largestCause(counters)).toBe("queue_full");
  });

  it("reads a collector slower than requestTimeoutMs by transportErrors, like an unreachable one", async () => {
    // Never answers. Each request is aborted at the timeout, which is a failed
    // request, so three of them end the send in a transport error.
    stub = await collector(() => undefined);
    const counters = await burst(stub.url, { requestTimeoutMs: 50, shutdownMs: 2_000 });
    expect(counters.transportErrors).toBeGreaterThan(0);
    expect(counters.droppedByCause.no_verdict).toBe(0);
  });

  it("moves neither for a collector that answers, only slower than shutdown waits", async () => {
    stub = await collector((events, response) => {
      setTimeout(() => {
        accepted(events, response);
      }, 400);
    });
    const counters = await burst(stub.url, { shutdownMs: 100 });
    expect(counters.transportErrors).toBe(0);
    expect(counters.droppedByCause.no_verdict).toBe(0);
    expect(counters.droppedByCause.shutdown).toBeGreaterThan(0);
    expect(largestCause(counters)).toBe("queue_full");
  });

  it("shows no transport error from a refused connection when shutdown comes before a send's third attempt", async () => {
    // The backoff before the second and third attempts is full jitter below
    // 100 and 200 ms; held near the top, three attempts take about 300 ms.
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    stub = await refusingEndpoint();
    const counters = await burst(stub.url, { shutdownMs: 100 });
    expect(counters.transportErrors).toBe(0);
    expect(counters.droppedByCause.no_verdict).toBe(0);
    expect(counters.droppedByCause.shutdown).toBeGreaterThan(0);
  });
});
