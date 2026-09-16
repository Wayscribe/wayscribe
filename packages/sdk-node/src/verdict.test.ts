import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Counters } from "./diagnostics.js";
import { createRecorder } from "./recorder.js";

const base = {
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

interface Run {
  counters: Counters;
  requests: number;
  printed: string[];
  reasons: string[];
}

/** Records `count` events against a server that always answers `status` with `body`. */
async function against(
  status: number,
  contentType: string,
  body: (events: unknown[]) => string,
  count = 3
): Promise<Run> {
  let requests = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests += 1;
      const { events } = JSON.parse(Buffer.concat(chunks).toString()) as { events: unknown[] };
      response.writeHead(status, { "content-type": contentType });
      response.end(body(events));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  const printed: string[] = [];
  const reasons: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const recorder = createRecorder({
    ...base,
    endpoint: `http://127.0.0.1:${String(port)}`,
    logDiagnostics: true,
    onDiagnostic: (d) => reasons.push(`${d.kind}|${d.code}|${d.reason}`)
  });
  const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
  for (let i = 0; i < count; i += 1)
    journey.record({ operation: "received", name: `n${String(i)}` });
  const counters = await recorder.shutdown({ timeoutMs: 5_000 });
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return { counters, requests, printed, reasons };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a 2xx without a verdict for every event", () => {
  it("counts a body that is not JSON as delivered without a verdict, once, and prints none of it", async () => {
    const run = await against(
      200,
      "text/html",
      () => "<html>secret-customer-ssn 123-45-6789</html>"
    );

    // Not retried: the server may well have stored them, and resending the
    // whole batch on a proxy's rewritten body would duplicate that work.
    expect(run.requests).toBe(1);
    expect(run.counters).toMatchObject({ sent: 0, rejected: 0, transportErrors: 0, dropped: 3 });
    const everything = [...run.printed, ...run.reasons].join("\n");
    expect(everything).not.toContain("secret-customer-ssn");
    expect(everything).not.toContain("123-45-6789");
    expect(run.printed.join("\n")).toContain(
      "dropped: The server's reply gave no verdict for this event (unparseable response body)"
    );
  });

  it("counts a JSON body with no results as no verdict", async () => {
    const run = await against(202, "application/json", () => "{}");
    expect(run.requests).toBe(1);
    expect(run.counters).toMatchObject({ sent: 0, rejected: 0, dropped: 3 });
    expect(run.reasons.filter((line) => line.startsWith("dropped|no_verdict"))).toHaveLength(3);
  });

  it("counts the events past the end of a short results array as no verdict", async () => {
    const run = await against(202, "application/json", () =>
      JSON.stringify({ data: { results: [{ status: "accepted" }] } })
    );
    expect(run.requests).toBe(1);
    expect(run.counters).toMatchObject({ sent: 1, rejected: 0, dropped: 2 });
  });

  it("counts a results entry that is not an object with a known status as no verdict", async () => {
    // A null in the middle used to throw while reading its status, so the
    // whole batch was retried three times and the accepted event resent.
    const run = await against(
      202,
      "application/json",
      () =>
        JSON.stringify({
          data: {
            results: [
              { status: "rejected", error: { code: "invalid_event", httpStatus: 400 } },
              null,
              { status: "accepted" },
              "accepted",
              7,
              { status: "maybe" }
            ]
          }
        }),
      6
    );
    expect(run.requests).toBe(1);
    expect(run.counters).toMatchObject({ sent: 1, rejected: 1, transportErrors: 0, dropped: 4 });
    expect(run.reasons.filter((line) => line.startsWith("dropped|no_verdict"))).toHaveLength(4);
  });

  it("ignores verdicts past the end of the batch", async () => {
    const run = await against(202, "application/json", (events) =>
      JSON.stringify({
        data: {
          results: [
            ...events.map(() => ({ status: "accepted" })),
            { status: "accepted" },
            { status: "rejected", error: { code: "invalid_event", httpStatus: 400 } }
          ]
        }
      })
    );
    expect(run.counters).toMatchObject({ sent: 3, rejected: 0, dropped: 0 });
  });
});
