import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder } from "./recorder.js";

const base = {
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

/** A stub ingestion route answering every event with `verdict`. */
async function ingestion(
  verdict: (index: number) => unknown
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { events: unknown[] };
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { results: parsed.events.map((_, i) => verdict(i)) } }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      })
  };
}

const accepted = (): unknown => ({ status: "accepted", eventId: "evt" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delivered_first", () => {
  it("is reported once, after the first batch the server stored anything from", async () => {
    const server = await ingestion(accepted);
    const seen: Diagnostic[] = [];
    const recorder = createRecorder({
      ...base,
      endpoint: server.endpoint,
      batchSize: 2,
      onDiagnostic: (d) => seen.push(d)
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    for (let i = 0; i < 6; i += 1) journey.record({ operation: "received", name: `n${String(i)}` });
    await recorder.flush();
    journey.record({ operation: "completed", name: "finish" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    await server.close();

    const first = seen.filter((d) => d.kind === "delivered_first");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ endpoint: server.endpoint, accepted: 2 });
    expect(first[0]?.reason).toContain(server.endpoint);
  });

  // Assembled, so a secret scanner reading this file does not see a token.
  const pathToken = ["sk", "live", "51FAKEPATHTOKEN0000"].join("_");
  const queryToken = ["fake", "query", "token", "0000"].join("-");
  it.each([
    ["a token in the path", `/ingest/${pathToken}`, pathToken],
    ["a token in the query", `?access_token=${queryToken}`, queryToken]
  ])("names only the scheme and host, not %s", async (_label, suffix, secret) => {
    // The endpoint string is printed under logDiagnostics, and an endpoint can
    // carry a path or query holding a credential that the masker does not
    // recognise by shape.
    const server = await ingestion(accepted);
    const seen: Diagnostic[] = [];
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const recorder = createRecorder({
      ...base,
      endpoint: `${server.endpoint}${suffix}`,
      logDiagnostics: true,
      onDiagnostic: (d) => seen.push(d)
    });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    vi.restoreAllMocks();
    await server.close();

    const [first] = seen.filter((d) => d.kind === "delivered_first");
    expect(first).toMatchObject({ endpoint: server.endpoint });
    const everything = [...lines, JSON.stringify(seen)].join("\n");
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("ingest/");
    expect(lines).toContain(
      `[flight-recorder] delivered_first: Connected to ${server.endpoint}; the server accepted 1 event.`
    );
  });

  it("is not reported while the server refuses everything", async () => {
    // The whole point of the signal: a key for the wrong environment reaches
    // the server and stores nothing, and must not read as connected.
    const server = await ingestion(() => ({
      status: "rejected",
      error: { code: "unauthorized_environment", message: "no", httpStatus: 403 }
    }));
    const seen: string[] = [];
    const recorder = createRecorder({
      ...base,
      endpoint: server.endpoint,
      onDiagnostic: (d) => seen.push(d.kind)
    });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    await server.close();

    expect(seen).toContain("rejected");
    expect(seen).not.toContain("delivered_first");
  });

  it("is not reported when the endpoint is unreachable", async () => {
    const seen: string[] = [];
    const recorder = createRecorder({
      ...base,
      endpoint: "http://127.0.0.1:1",
      onDiagnostic: (d) => seen.push(d.kind)
    });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 1_000 });
    expect(seen).not.toContain("delivered_first");
  });
});

describe("the console", () => {
  function spyOnEveryConsoleChannel(): (() => number)[] {
    const channels = ["error", "warn", "log", "info", "debug"] as const;
    const spies = channels.map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined)
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return [...spies, stdout, stderr].map((spy) => () => spy.mock.calls.length);
  }

  it("is untouched by default, through success, refusal, failure, and shedding", async () => {
    let call = 0;
    const server = await ingestion(() => {
      call += 1;
      return call % 2 === 0
        ? accepted()
        : { status: "rejected", error: { code: "invalid_event", message: "no", httpStatus: 400 } };
    });
    const counts = spyOnEveryConsoleChannel();

    const healthy = createRecorder({ ...base, endpoint: server.endpoint, maxBufferedEvents: 3 });
    const journey = healthy.startJourney({ entity: { type: "customer", id: "1" } });
    for (let i = 0; i < 10; i += 1) journey.record({ operation: "received", name: "n" });
    journey.transform("t", { big: "x".repeat(300_000) }, () => 1);
    await healthy.shutdown({ timeoutMs: 2_000 });

    const dead = createRecorder({ ...base, endpoint: "http://127.0.0.1:1" });
    dead.startJourney({ entity: { type: "customer", id: "1" } }).fail("f", new Error("boom"));
    await dead.shutdown({ timeoutMs: 1_000 });

    const calls = counts.map((count) => count());
    vi.restoreAllMocks();
    await server.close();

    expect(healthy.diagnostics().rejected).toBeGreaterThan(0);
    expect(healthy.diagnostics().dropped).toBeGreaterThan(0);
    expect(healthy.diagnostics().sent).toBeGreaterThan(0);
    expect(calls.every((count) => count === 0)).toBe(true);
  });

  it("says connected when logDiagnostics is on", async () => {
    const server = await ingestion(accepted);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const recorder = createRecorder({ ...base, endpoint: server.endpoint, logDiagnostics: true });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    vi.restoreAllMocks();
    await server.close();

    expect(lines).toEqual([
      `[flight-recorder] delivered_first: Connected to ${server.endpoint}; the server accepted 1 event.`
    ]);
  });

  it("prints a refusal's code and field path, and leaves the server's message to onDiagnostic", async () => {
    // Flight Recorder's API puts no event values in its messages, but a proxy
    // or another server in front of it could, and a console line usually ends
    // up in a log store the operator does not control.
    const server = await ingestion(() => ({
      status: "rejected",
      error: {
        code: "invalid_event",
        message: "Value dana@example.com is not allowed.",
        httpStatus: 400,
        details: [{ path: "event.aliases.email", message: "got dana@example.com" }]
      }
    }));
    const lines: string[] = [];
    const reasons: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const recorder = createRecorder({
      ...base,
      endpoint: server.endpoint,
      logDiagnostics: true,
      onDiagnostic: (d) => reasons.push(d.reason)
    });
    recorder.startJourney({ entity: { type: "customer", id: "cus_secret_id" } }).record({
      operation: "received",
      name: "n",
      input: { email: "dana@example.com" }
    });
    await recorder.shutdown({ timeoutMs: 2_000 });
    vi.restoreAllMocks();
    await server.close();

    expect(lines).toEqual([
      "[flight-recorder] rejected: invalid_event at event.aliases.email (the server's message goes to onDiagnostic)"
    ]);
    expect(lines.join()).not.toContain("cus_secret_id");
    expect(lines.join()).not.toContain("fr_test");
    // Nothing is lost: the callback still gets the whole message.
    expect(reasons.join()).toContain("Value dana@example.com is not allowed.");
  });

  it("prints no server message for a refusal for now either", async () => {
    const server = await ingestion(() => ({
      status: "rejected",
      error: {
        code: "query_timeout",
        message: "Timed out storing dana@example.com.",
        httpStatus: 503
      }
    }));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const recorder = createRecorder({ ...base, endpoint: server.endpoint, logDiagnostics: true });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    vi.restoreAllMocks();
    await server.close();

    expect(lines).toContain(
      "[flight-recorder] transport_error: query_timeout (the server's message goes to onDiagnostic)"
    );
    expect(lines.join()).not.toContain("dana@example.com");
  });

  it("prints a code only when it looks like one", async () => {
    const server = await ingestion(() => ({
      status: "rejected",
      error: { code: "bad value dana@example.com", message: "no", httpStatus: 400 }
    }));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const recorder = createRecorder({ ...base, endpoint: server.endpoint, logDiagnostics: true });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 2_000 });
    vi.restoreAllMocks();
    await server.close();

    expect(lines).toEqual([
      "[flight-recorder] rejected: rejected (the server's message goes to onDiagnostic)"
    ]);
  });

  it("reports suppressed repeats at shutdown", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const recorder = createRecorder({
      ...base,
      endpoint: "http://127.0.0.1:1",
      maxBufferedEvents: 1,
      logDiagnostics: true
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    for (let i = 0; i < 4; i += 1) journey.record({ operation: "received", name: "n" });
    await recorder.shutdown({ timeoutMs: 1_000 });
    vi.restoreAllMocks();

    expect(lines).toContain("[flight-recorder] dropped: queue_full");
    // Three: two shed as the queue of one filled, and the event still queued
    // when shutdown gave up on the unreachable endpoint.
    expect(lines).toContain("[flight-recorder] dropped: 3 repeats suppressed since the last line");
  });
});
