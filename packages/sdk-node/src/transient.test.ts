import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

const base = {
  apiKey: "fr_test",
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
): Promise<ReturnType<ReturnType<typeof createRecorder>["diagnostics"]>> {
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

  it("stops after the attempt limit for a 503 that never clears, and loses nothing else", async () => {
    const seen: string[] = [];
    const server = await ingestion((name) =>
      name === "poison" ? refused(503, "query_timeout") : accepted
    );
    const recorder = createRecorder({
      ...base,
      endpoint: server.endpoint,
      batchSize: 2,
      onDiagnostic: (d) => seen.push(`${d.kind}|${d.reason}`)
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    journey.record({ operation: "received", name: "poison" });
    for (let i = 0; i < 9; i += 1)
      journey.record({ operation: "received", name: `ok${String(i)}` });
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    await server.close();

    // Three attempts, the transport's limit, and then no more: an event the
    // server cannot store must not lead every later batch.
    expect(count(server.received, "poison")).toBe(3);
    expect(counters).toMatchObject({ sent: 9, rejected: 0, transportErrors: 1, dropped: 1 });
    expect(counters.breakerOpened).toBe(0);
    expect(seen.some((line) => line.startsWith("transport_error|query_timeout"))).toBe(true);
    expect(seen.some((line) => line.startsWith("rejected|"))).toBe(false);
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
