import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Journey, type RecorderConfig } from "./index.js";

/**
 * The SDK sends only events the server's limits accept.
 *
 * It used to measure each payload on its own and scale its string limit with
 * `maxPayloadBytes`, while the server measures the whole envelope and never
 * scaled anything. A 70,000 character string was then refused
 * `max_string_length_exceeded`, and the whole event was lost. Now a long string
 * is cut, a payload that still does not fit is omitted, and the event is sent.
 */

interface Captured {
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  counters: Counters;
}

async function capture(
  record: (journey: Journey) => void,
  settings: Partial<RecorderConfig> = {}
): Promise<Captured> {
  const events: Record<string, unknown>[] = [];
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
  const diagnostics: Diagnostic[] = [];
  try {
    const recorder = createRecorder({
      endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      ...settings
    });
    record(recorder.startJourney({ entity: { type: "customer", id: "1" } }));
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    return { events, diagnostics, counters };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const MARKER_4500 = "[TRUNCATED: 4500 characters removed]";

describe("fitting an event to the server's limits", () => {
  it("cuts a string over 65,536 code units and says how much went", async () => {
    const { events, diagnostics, counters } = await capture((journey) => {
      journey.record({
        operation: "received",
        name: "fetch",
        input: { note: "a".repeat(70_000), short: "kept" }
      });
    });

    expect(events).toHaveLength(1);
    const input = events[0]?.["input"] as { note: string; short: string };
    expect(input.short).toBe("kept");
    expect(input.note).toBe(`${"a".repeat(65_500)}${MARKER_4500}`);
    expect(input.note).toHaveLength(65_536);

    expect(counters.payloadsTruncated).toBe(1);
    expect(counters.payloadsOmitted).toBe(0);
    expect(diagnostics.filter((d) => d.kind === "payload_truncated")).toEqual([
      {
        kind: "payload_truncated",
        code: "strings_cut",
        reason: expect.stringContaining("input") as string,
        detail: { field: "input", strings: 1, charactersRemoved: 4_500 }
      }
    ]);
  });

  it("cuts strings in output and metadata too, counting each payload once", async () => {
    const { events, counters } = await capture((journey) => {
      journey.record({
        operation: "transformed",
        name: "t",
        output: ["b".repeat(70_000), "c".repeat(70_000)],
        metadata: { corpus: "d".repeat(66_000) }
      });
    });
    const event = events[0] ?? {};
    expect((event["output"] as string[]).map((s) => s.length)).toEqual([65_536, 65_536]);
    expect((event["metadata"] as { corpus: string }).corpus).toHaveLength(65_536);
    expect(counters.payloadsTruncated).toBe(2);
  });

  it("omits the larger payload when two that fit alone do not fit together", async () => {
    const { events, diagnostics, counters } = await capture((journey) => {
      journey.record({
        operation: "transformed",
        name: "normalize",
        // 180 KB and 100 KB: each fits the 256 KiB budget, and together they
        // do not.
        input: { raw: "i".repeat(60_000), more: "j".repeat(60_000), most: "k".repeat(60_000) },
        output: { normalized: "o".repeat(50_000), more: "p".repeat(50_000) },
        metadata: { tenant: "acme" }
      });
    });
    const event = events[0] ?? {};
    expect(event["input"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect((event["output"] as { normalized: string }).normalized).toHaveLength(50_000);
    expect(event["metadata"]).toEqual({ tenant: "acme" });
    expect(counters.payloadsOmitted).toBe(1);
    expect(diagnostics.find((d) => d.kind === "payload_omitted")).toMatchObject({
      code: "too_large",
      detail: { field: "input" }
    });
  });

  it("keeps the smaller payload whichever side it is on", async () => {
    const { events } = await capture(
      (journey) => {
        journey.record({
          operation: "transformed",
          name: "t",
          input: "x".repeat(600),
          output: "y".repeat(700)
        });
      },
      { maxPayloadBytes: 1_200 }
    );
    expect(events[0]?.["input"]).toBe("x".repeat(600));
    expect(events[0]?.["output"]).toBe("[PAYLOAD_TOO_LARGE]");
  });

  it("drops metadata last, when omitting both payloads was not enough", async () => {
    const { events, counters } = await capture(
      (journey) => {
        journey.record({
          operation: "transformed",
          name: "t",
          input: "x".repeat(300),
          output: "y".repeat(300),
          metadata: { big: "m".repeat(700) }
        });
      },
      { maxPayloadBytes: 1_000 }
    );
    const event = events[0] ?? {};
    expect(event["input"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect(event["output"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect(event).not.toHaveProperty("metadata");
    expect(counters.payloadsOmitted).toBe(3);
    expect(counters.sent).toBe(1);
  });

  it("omits a payload the server would refuse as too deep, rather than losing the event", async () => {
    let nested: unknown = "leaf";
    for (let level = 0; level < 31; level += 1) nested = { n: nested };
    const { events, diagnostics } = await capture((journey) => {
      journey.record({ operation: "received", name: "deep", input: nested });
    });
    expect(events[0]?.["input"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect(diagnostics.find((d) => d.kind === "payload_omitted")).toMatchObject({
      code: "too_deep",
      detail: { field: "input" }
    });
  });

  it("still sends a payload exactly at the depth the server accepts", async () => {
    let nested: unknown = "leaf";
    for (let level = 0; level < 30; level += 1) nested = { n: nested };
    const { events } = await capture((journey) => {
      journey.record({ operation: "received", name: "deep", input: nested });
    });
    expect(events[0]?.["input"]).toEqual(nested);
  });

  it("reports a payload cut and then omitted as omitted only", async () => {
    const { events, counters } = await capture((journey) => {
      journey.record({
        operation: "received",
        name: "five",
        input: Array.from({ length: 5 }, () => "a".repeat(70_000))
      });
    });
    expect(events[0]?.["input"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect(counters.payloadsOmitted).toBe(1);
    expect(counters.payloadsTruncated).toBe(0);
  });

  it("does not scale the string limit with maxPayloadBytes any more", async () => {
    // The old behaviour: raising maxPayloadBytes to 5 MB let a 70 KB string
    // through, and the server refused the event.
    const { events } = await capture(
      (journey) => {
        journey.record({ operation: "received", name: "r", input: "e".repeat(70_000) });
      },
      { maxPayloadBytes: 5_000_000 }
    );
    expect(events[0]?.["input"]).toBe(`${"e".repeat(65_500)}${MARKER_4500}`);
  });

  it("masks a secret before cutting, so a cut never reveals it", async () => {
    const { events, counters } = await capture((journey) => {
      journey.record({
        operation: "received",
        name: "r",
        input: { password: "s".repeat(70_000) }
      });
    });
    expect(events[0]?.["input"]).toEqual({ password: "[REDACTED]" });
    expect(counters.payloadsTruncated).toBe(0);
  });

  it("masks a header line named by a configured path before cutting the block", async () => {
    const { events, counters } = await capture(
      (journey) => {
        journey.record({
          operation: "received",
          name: "r",
          input: { raw: `x-internal-token: ${"v".repeat(70_000)}\r\nhost: example.com\r\n\r\n` }
        });
      },
      { redact: ["**.x-internal-token"] }
    );
    expect(events[0]?.["input"]).toEqual({
      raw: "x-internal-token: [REDACTED]\r\nhost: example.com\r\n\r\n"
    });
    expect(counters.payloadsTruncated).toBe(0);
  });

  it("keeps a line break before the marker when it cuts a header block it cannot mask", async () => {
    // The environment may name this header; only the server knows. Keeping a
    // line break lets the server's masking still read the first line.
    const { events } = await capture((journey) => {
      journey.record({
        operation: "received",
        name: "r",
        input: { raw: `x-internal-token: ${"v".repeat(70_000)}\r\nhost: example.com\r\n\r\n` }
      });
    });
    const raw = (events[0]?.["input"] as { raw: string }).raw;
    expect(raw).toHaveLength(65_536);
    expect(raw.endsWith("\r\n[TRUNCATED: 4543 characters removed]")).toBe(true);
  });

  it("keeps the exact accounting: sent + rejected + dropped equals recorded", async () => {
    const { counters } = await capture((journey) => {
      for (let index = 0; index < 5; index += 1) {
        journey.record({ operation: "received", name: "r", input: "z".repeat(70_000) });
      }
    });
    expect(counters.sent + counters.rejected + counters.dropped).toBe(5);
    expect(counters.payloadsTruncated).toBe(5);
  });
});
