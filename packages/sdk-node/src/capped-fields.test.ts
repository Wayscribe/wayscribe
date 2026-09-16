import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { journeyEventSchema } from "@flight-recorder/protocol";
import { describe, expect, it } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Journey } from "./index.js";

/**
 * The protocol caps some keys and short fields, and the server refuses the
 * whole event over one of them. A metadata key of 129 characters was the only
 * refusal a fuzz run of the SDK found. The SDK now applies those caps too:
 * an over-long key is dropped, with a marker where one can go and a diagnostic
 * always, and the event is sent.
 */

interface Captured {
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  counters: Counters;
}

async function capture(record: (journey: Journey) => void): Promise<Captured> {
  const events: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
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

const long = "k".repeat(129);
/** 128 astral characters: 256 code units, and within the cap, which counts code points. */
const astral = "😀".repeat(128);

/** What the server would say about the event, by its own schema. */
const valid = (event: Record<string, unknown> | undefined): boolean =>
  journeyEventSchema.safeParse(event).success;

describe("capped keys and fields", () => {
  it("drops a metadata key over 128 characters, leaves a marker, and sends the event", async () => {
    const { events, diagnostics, counters } = await capture((journey) => {
      journey.record({
        operation: "received",
        name: "r",
        metadata: { [long]: 1, [astral]: 2, tenant: "acme" }
      });
    });
    expect(events[0]?.["metadata"]).toEqual({ [astral]: 2, tenant: "acme", "[KEY_TOO_LONG]": 1 });
    expect(valid(events[0])).toBe(true);
    expect(counters.keysDropped).toBe(1);
    expect(counters.sent).toBe(1);
    expect(diagnostics.find((d) => d.kind === "key_dropped")?.detail).toEqual({
      field: "metadata",
      keys: 1
    });
    // The key itself can carry data, so it is not quoted back.
    expect(JSON.stringify(diagnostics)).not.toContain(long);
  });

  it("drops an alias whose type or value the server would refuse, and keeps the rest", async () => {
    const { events, counters, diagnostics } = await capture((journey) => {
      journey.identify(
        {
          [long]: "x",
          good: "y",
          tooLongValue: "v".repeat(513),
          notAString: 7 as unknown as string
        },
        { displayable: ["good", long] }
      );
    });
    // No marker among aliases: it would become a searchable alias.
    expect(events[0]?.["aliases"]).toEqual({ good: "y" });
    expect(events[0]?.["displayableAliases"]).toEqual(["good"]);
    expect(valid(events[0])).toBe(true);
    // Two reports, one per field, covering three aliases and one displayable
    // type. The counter counts reports; the detail counts entries.
    expect(counters.keysDropped).toBe(2);
    expect(diagnostics.filter((d) => d.kind === "key_dropped")).toMatchObject([
      { code: "alias_invalid", detail: { field: "aliases", keys: 3 } },
      { code: "displayable_alias_invalid", detail: { field: "displayableAliases", keys: 1 } }
    ]);
  });

  it("keeps a __proto__ alias as an own key", async () => {
    const aliases = JSON.parse('{"__proto__": "p", "good": "y"}') as Record<string, string>;
    const { events } = await capture((journey) => {
      journey.identify(aliases);
    });
    expect(Object.keys(events[0]?.["aliases"] as object)).toEqual(["__proto__", "good"]);
  });

  it("cuts an error type or code the server would refuse", async () => {
    const { events } = await capture((journey) => {
      journey.record({
        operation: "failed",
        name: "f",
        error: { message: "boom", type: "T".repeat(300), code: "C".repeat(300) }
      });
      const error = Object.assign(new Error("boom"), { code: "E".repeat(300) });
      error.name = "N".repeat(300);
      journey.fail("f2", error);
    });
    for (const event of events) {
      const error = event["error"] as { type: string; code: string };
      expect(error.type.length).toBeLessThanOrEqual(256);
      expect(error.code.length).toBeLessThanOrEqual(256);
      expect(error.code.endsWith("[TRUNCATED]")).toBe(true);
      expect(valid(event)).toBe(true);
    }
  });

  it("changes nothing, and counts nothing, for fields within the caps", async () => {
    const { events, counters } = await capture((journey) => {
      journey.identify({ [astral]: "y".repeat(512) }, { displayable: [astral] });
    });
    expect(events[0]?.["aliases"]).toEqual({ [astral]: "y".repeat(512) });
    expect(counters.keysDropped).toBe(0);
  });
});
