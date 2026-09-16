import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expand, type ConformanceCase } from "@flight-recorder/protocol/conformance";
import { createRecorder, type Journey, type RecordInput } from "./recorder.js";

/**
 * Drive a conformance case against the real recorder and capture what it sent.
 *
 * Not a test file, and not part of the published package: two suites need this
 * and neither may build a request body of its own. The SDK unit test compares
 * the captured body with the case, and the API integration test sends the same
 * bytes to the dry run. A second copy of this would make the second suite a
 * test of a second implementation.
 *
 * Excluded from tsconfig.build.json, so it emits no declaration into dist and
 * never reaches npm; the bundler only follows index.ts in any case.
 */

export interface CapturedCase {
  id: string;
  /** Every event the recorder put on the wire, in order, across every request. */
  events: Record<string, unknown>[];
  /** How many requests it took, which is what the batch-size case is about. */
  requests: number;
}

/**
 * Drive one case against a stub endpoint and return what the recorder sent.
 *
 * Exported so the integration test replays exactly these bytes rather than
 * building its own, which would make it a test of a second implementation.
 */
export async function captureCase(one: ConformanceCase, run: string): Promise<CapturedCase> {
  const events: Record<string, unknown>[] = [];
  let requests = 0;

  const server = createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    incoming.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
      events.push(...parsed.events.map((entry) => entry.event));
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

  const settings = (one.recorder ?? {}) as {
    maxPayloadBytes?: number;
    redact?: string[];
    captureMode?: "metadata-only" | "redacted-payload" | "full-payload";
  };
  const recorder = createRecorder({
    endpoint: `http://127.0.0.1:${String(port)}`,
    apiKey: "fr_test_conformance",
    serviceName: "customer-integration",
    environment: "conformance",
    ...settings
  });

  try {
    const journey = recorder.startJourney({ entity: { type: "customer", id: "0018Z00002ABC" } });
    for (const call of one.calls ?? []) {
      for (let repeat = 0; repeat < (call.repeat ?? 1); repeat += 1) {
        await makeCall(journey, call, run);
      }
    }
    await recorder.shutdown({ timeoutMs: 5_000 });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  return { id: one.id, events, requests };
}

type Call = NonNullable<ConformanceCase["calls"]>[number];

async function makeCall(journey: Journey, call: Call, run: string): Promise<void> {
  const args = expand(call.args ?? {}, { run, host: true }) as Record<string, unknown>;
  const name = call.name ?? "receive-order";

  switch (call.call) {
    case "record":
      journey.record(args as unknown as RecordInput);
      return;
    case "identify":
      journey.identify(args["aliases"] as Record<string, string>);
      return;
    case "fail":
      journey.fail(name, args["error"], args["metadata"] as Record<string, unknown>);
      return;
    case "finish":
      journey.finish({ status: args["status"] as "completed" | "failed" });
      return;
    default: {
      // The four wrappers take the same shape: a name, the value going in, a
      // callback whose return value is the value coming out, and options.
      const wrapper = journey[call.call].bind(journey) as (
        wrapperName: string,
        input: unknown,
        fn: () => unknown,
        options?: unknown
      ) => unknown;
      await wrapper(name, args["input"], () => args["output"], args["options"]);
      return;
    }
  }
}
