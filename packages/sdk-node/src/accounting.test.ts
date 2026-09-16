import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Counters } from "./diagnostics.js";
import { createRecorder } from "./recorder.js";

const base = {
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

async function serving(
  handler: (events: unknown[], response: ServerResponse) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { events } = JSON.parse(Buffer.concat(chunks).toString()) as { events: unknown[] };
      handler(events, response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      })
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Every recorded event is stored, refused, or dropped, and counted exactly once. */
function accountedFor(counters: Counters): number {
  return counters.sent + counters.rejected + counters.dropped;
}

async function record(
  endpoint: string,
  count: number,
  timeoutMs: number,
  extra: Record<string, unknown> = {}
): Promise<{ counters: Counters; later: () => Counters }> {
  const recorder = createRecorder({ ...base, endpoint, ...extra });
  const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
  for (let i = 0; i < count; i += 1)
    journey.record({ operation: "received", name: `n${String(i)}` });
  const counters = await recorder.shutdown({ timeoutMs });
  return { counters, later: () => recorder.diagnostics() };
}

describe("every recorded event is accounted for at shutdown", () => {
  it("counts events the server was still refusing for now as dropped", async () => {
    const server = await serving((events, response) => {
      json(response, 202, {
        data: {
          results: events.map(() => ({
            status: "rejected",
            error: { code: "storage_error", message: "db down", httpStatus: 503 }
          }))
        }
      });
    });
    const { counters } = await record(server.endpoint, 3, 5_000);
    await server.close();

    expect(counters).toMatchObject({ sent: 0, rejected: 0, dropped: 3 });
    expect(accountedFor(counters)).toBe(3);
  });

  it("counts events still queued against an unreachable endpoint as dropped", async () => {
    // 3,000 recorded into a queue of 1,000: 2,000 are shed as it fills, and the
    // 1,000 left at shutdown used to vanish with no counter at all.
    const { counters } = await record("http://127.0.0.1:1", 3_000, 3_000);
    expect(counters).toMatchObject({ sent: 0, rejected: 0, dropped: 3_000 });
  });

  it("counts a batch still in flight when the timeout wins, and nothing more afterwards", async () => {
    // A server that takes the request and never answers.
    const server = await serving(() => undefined);
    const { counters, later } = await record(server.endpoint, 3, 200);

    expect(counters).toMatchObject({ sent: 0, rejected: 0, dropped: 3 });
    // The abandoned request must not be counted again when it fails later.
    await new Promise((resolve) => {
      setTimeout(resolve, 1_800);
    });
    expect(later()).toEqual(counters);
    await server.close();
  });

  it("counts each event of a batch the server refused outright", async () => {
    const server = await serving((_events, response) => {
      json(response, 401, { error: { code: "unauthorized", message: "no" } });
    });
    const { counters } = await record(server.endpoint, 3, 2_000);
    await server.close();

    expect(counters).toMatchObject({ sent: 0, rejected: 3, dropped: 0 });
  });

  it("keeps the invariant when a payload is too large to capture", async () => {
    // The event is still sent, with a marker in place of its payload, so the
    // omission is its own counter. Counting it as dropped counted one event
    // twice.
    const server = await serving((events, response) => {
      json(response, 202, { data: { results: events.map(() => ({ status: "accepted" })) } });
    });
    const recorder = createRecorder({ ...base, endpoint: server.endpoint, maxPayloadBytes: 1_000 });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    journey.record({ operation: "received", name: "small", input: { a: 1 } });
    journey.record({ operation: "received", name: "big", input: { blob: "x".repeat(5_000) } });
    journey.record({ operation: "received", name: "small-again" });
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    await server.close();

    expect(counters).toMatchObject({ sent: 3, rejected: 0, dropped: 0, payloadsOmitted: 1 });
    expect(accountedFor(counters)).toBe(3);
  });

  it("counts a healthy run as all sent", async () => {
    // The control: an accounting change that dropped everything at shutdown
    // would pass every test above.
    const server = await serving((events, response) => {
      json(response, 202, { data: { results: events.map(() => ({ status: "accepted" })) } });
    });
    const { counters } = await record(server.endpoint, 120, 5_000, { batchSize: 50 });
    await server.close();

    expect(counters).toMatchObject({ sent: 120, rejected: 0, dropped: 0 });
  });
});

describe("shutdown's own timer", () => {
  it("is cleared and unreferenced once the drain wins", async () => {
    // The race used a plain setTimeout that was never cleared, so a process
    // whose drain finished at once was held open for the rest of the timeout.
    const created: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler: () => void, ms?: number) => {
        const timer = realSetTimeout(handler, ms);
        if (ms === 4_321) created.push(timer);
        return timer;
      });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const recorder = createRecorder({ ...base, endpoint: "http://127.0.0.1:1" });
    await recorder.shutdown({ timeoutMs: 4_321 });

    expect(created).toHaveLength(1);
    const [timer] = created;
    expect(timer?.hasRef()).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(timer);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
