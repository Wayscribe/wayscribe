import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder, type RecorderConfig } from "./index.js";

/**
 * The codes a host matches on, from the paths that report them. `reason` is
 * prose and may change; these may not, so each is pinned here.
 */

const base = {
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

async function answering(
  reply: (events: unknown[], response: ServerResponse) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      reply((JSON.parse(body) as { events: unknown[] }).events, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      })
  };
}

function recording(config: Partial<RecorderConfig> & { endpoint: string }): {
  recorder: ReturnType<typeof createRecorder>;
  seen: Diagnostic[];
} {
  const seen: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    ...config,
    onDiagnostic: (d) => seen.push(d)
  });
  return { recorder, seen };
}

describe("diagnostic codes", () => {
  it("names a per-event refusal event_refused, with the server's error in serverError", async () => {
    const serverError = { code: "invalid_event", message: "no", httpStatus: 400 };
    const server = await answering((events, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: { results: events.map(() => ({ status: "rejected", error: serverError })) }
        })
      );
    });
    const { recorder, seen } = recording({ endpoint: server.endpoint });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    await server.close();

    expect(seen.filter((d) => d.kind === "rejected")).toEqual([
      {
        kind: "rejected",
        code: "event_refused",
        reason: expect.stringContaining("invalid_event") as string,
        detail: { serverError }
      }
    ]);
  });

  it("names a whole request refused with a 4xx request_refused, with its status", async () => {
    const server = await answering((_events, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "no" } }));
    });
    const { recorder, seen } = recording({ endpoint: server.endpoint });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    journey.record({ operation: "received", name: "a" });
    journey.record({ operation: "received", name: "b" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    await server.close();

    const rejected = seen.filter((d) => d.kind === "rejected");
    expect(rejected).toHaveLength(2);
    for (const one of rejected) {
      expect(one).toMatchObject({
        code: "request_refused",
        detail: { events: 2, httpStatus: 401 }
      });
    }
  });

  it("names an event left undelivered at shutdown shutdown, and one recorded after it after_shutdown", async () => {
    const { recorder, seen } = recording({ endpoint: "http://127.0.0.1:1" });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    journey.record({ operation: "received", name: "before" });
    await recorder.shutdown({ timeoutMs: 200 });
    journey.record({ operation: "completed", name: "after" });

    const dropped = seen.filter((d) => d.kind === "dropped");
    expect(dropped.map((d) => d.code)).toEqual(["shutdown", "after_shutdown"]);
    expect(dropped[0]?.detail).toEqual({});
    expect(dropped[1]?.detail).toEqual({ name: "after", operation: "completed" });
  });

  it("names a queue overflow queue_full", async () => {
    const { recorder, seen } = recording({
      endpoint: "http://127.0.0.1:1",
      maxBufferedEvents: 1,
      flushIntervalMs: 60_000
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    journey.record({ operation: "received", name: "a" });
    journey.record({ operation: "received", name: "b" });
    expect(seen.filter((d) => d.kind === "dropped")).toEqual([
      {
        kind: "dropped",
        code: "queue_full",
        reason: "The queue was full, so its oldest event was dropped.",
        detail: {}
      }
    ]);
    await recorder.shutdown({ timeoutMs: 50 });
  });

  it("names an unusable setting by its name, and a required one apart", async () => {
    const { recorder, seen } = recording({
      endpoint: "http://127.0.0.1:1",
      serviceName: 7 as unknown as string,
      batchSize: "5" as unknown as number
    });
    const problems = seen
      .filter((d) => d.kind === "configuration_error")
      .map((d) => [d.code, d.detail]);
    expect(problems).toEqual(
      expect.arrayContaining([
        ["required_setting_unusable", { setting: "serviceName" }],
        ["setting_unusable", { setting: "batchSize" }]
      ])
    );
    // The value is never part of it.
    expect(JSON.stringify(seen.filter((d) => d.kind === "configuration_error"))).not.toContain(
      '"5"'
    );
    await recorder.shutdown({ timeoutMs: 50 });
  });
});
