import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expand, type ConformanceCase } from "@flight-recorder/protocol/conformance";
import {
  createRecorder,
  type Journey,
  type JourneyGroup,
  type RecordInput,
  type Recorder
} from "./recorder.js";

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
  /** Every diagnostic the recorder reported, in order, as `{ kind, reason, detail }`. */
  diagnostics: { kind: string; reason: string; detail?: unknown }[];
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
    // Decoded as a stream, not chunk by chunk: a two-byte character split
    // across two chunks decodes as two replacement characters, which made a
    // string the SDK had cut to the limit arrive one code unit over it.
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
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
  const diagnostics: CapturedCase["diagnostics"] = [];
  const recorder = createRecorder({
    endpoint: `http://127.0.0.1:${String(port)}`,
    apiKey: "fr_test_conformance",
    serviceName: "customer-integration",
    environment: "conformance",
    onDiagnostic: ({ kind, reason, detail }) => {
      diagnostics.push({ kind, reason, detail });
    },
    ...settings
  });

  try {
    const journey = recorder.startJourney({ entity: { type: "customer", id: "0018Z00002ABC" } });
    for (const call of one.calls ?? []) {
      const target =
        call.journeys === undefined ? journey : groupOf(recorder, journey, call.journeys);
      for (let repeat = 0; repeat < (call.repeat ?? 1); repeat += 1) {
        await makeCall(target, call, run);
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

  return { id: one.id, events, requests, diagnostics };
}

type Call = NonNullable<ConformanceCase["calls"]>[number];

/** The case's journey and `size - 1` more, for a call that records on a group. */
function groupOf(recorder: Recorder, first: Journey, size: number): JourneyGroup {
  const others = Array.from({ length: size - 1 }, (_unused, index) =>
    recorder.startJourney({
      entity: { type: "customer", id: `0018Z00002ABC-${String(index + 2)}` }
    })
  );
  return recorder.across([first, ...others]);
}

async function makeCall(target: Journey | JourneyGroup, call: Call, run: string): Promise<void> {
  const args = expand(call.args ?? {}, { run, host: true }) as Record<string, unknown>;
  const name = call.name ?? "receive-order";

  switch (call.call) {
    case "record":
      target.record(args as unknown as RecordInput);
      return;
    case "identify":
      if (!("identify" in target)) throw new Error("identify has no group form.");
      target.identify(
        args["aliases"] as Record<string, string>,
        args["options"] as { displayable?: string[] } | undefined
      );
      return;
    case "label":
      if (!("label" in target)) throw new Error("label has no group form.");
      target.label(args["text"] as string);
      return;
    case "fail":
      target.fail(name, args["error"], args["metadata"] as Record<string, unknown>);
      return;
    case "finish":
      target.finish({ status: args["status"] as "completed" | "failed" });
      return;
    default: {
      // The four wrappers take the same shape: a name, the value going in, a
      // callback whose return value is the value coming out, and options.
      const wrapper = target[call.call].bind(target) as (
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
