import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createRecorder, type Journey } from "./recorder.js";

// Built by concatenation so a scanner reading this file does not see a
// credential, and so a leak is unmistakable if one of these reaches the wire.
const TUPLE = "Bearer " + "tok" + "_sdk_shape_" + "TUPLE11";
const RAW = "Bearer " + "tok" + "_sdk_shape_" + "RAW12";
const COOKIE = "sid=" + "cookie" + "_sdk_shape_" + "RAW13";
const REQUEST = "Bearer " + "tok" + "_sdk_shape_" + "REQ14";

/** Every event the recorder delivered, read from the raw request body. */
async function collect(use: (journey: Journey) => unknown): Promise<Record<string, unknown>[]> {
  const received: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
      received.push(...parsed.events.map((entry) => entry.event));
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: { results: parsed.events.map(() => ({ status: "accepted" })) } })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  const recorder = createRecorder({
    endpoint: `http://127.0.0.1:${String(port)}`,
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development"
  });
  await use(recorder.startJourney({ entity: { type: "customer", id: "1" } }));
  await recorder.shutdown({ timeoutMs: 2_000 });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return received;
}

/**
 * The SDK bundles payload-security's redaction, so the header shapes the
 * security review stored through the default capture mode are redacted before
 * they leave the host application, not only by the server.
 */
describe("header shapes redacted before sending", () => {
  it("redacts header tuples, rawHeaders and a real ClientRequest's header block", async () => {
    const clientRequest = await new Promise<unknown>((resolve) => {
      const outgoing = request({
        host: "127.0.0.1",
        port: 1,
        method: "POST",
        path: "/oauth/token",
        headers: { Authorization: REQUEST }
      });
      outgoing.on("error", (error) => {
        resolve({ error, request: outgoing });
      });
      outgoing.end("{}");
    });

    const events = await collect((journey) => {
      journey.record({
        operation: "delivered",
        name: "call-upstream",
        input: {
          init: {
            headers: [
              ["Authorization", TUPLE],
              ["x-request-id", "req_42"]
            ]
          },
          rawHeaders: ["Host", "api.example.com", "Authorization", RAW, "Cookie", COOKIE],
          failure: clientRequest
        }
      });
    });

    const raw = JSON.stringify(events.find((event) => event["name"] === "call-upstream"));
    // Presence first: an input dropped whole would pass every absence check.
    expect(raw).toContain("req_42");
    expect(raw).toContain("api.example.com");
    expect(raw).toContain("/oauth/token");
    expect(raw).not.toContain("TUPLE11");
    expect(raw).not.toContain("RAW12");
    expect(raw).not.toContain("RAW13");
    expect(raw).not.toContain("REQ14");
  });
});
