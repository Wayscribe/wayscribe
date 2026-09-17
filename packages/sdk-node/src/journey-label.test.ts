import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_JOURNEY_LABEL_LENGTH, journeyEventSchema } from "@wayscribe/protocol";
import { describe, expect, it } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Journey, type Recorder } from "./index.js";

/**
 * `journey.label(text)` names a journey for the Journeys page. It records
 * nothing itself; every later event of that journey object carries the label,
 * so the server's "latest operation start wins" rule settles it and a dropped
 * event cannot take the label with it.
 */

interface Captured {
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  counters: Counters;
}

/**
 * Runs `record` against a stub that accepts every event unless `refuse` says
 * otherwise, and returns what arrived.
 */
async function capture(
  record: (recorder: Recorder) => Promise<void> | void,
  refuse: (index: number) => boolean = () => false,
  settings: { maxEventBytes?: number } = {}
): Promise<Captured> {
  const events: Record<string, unknown>[] = [];
  let seen = 0;
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
      events.push(...parsed.events.map((entry) => entry.event));
      const results = parsed.events.map(() => {
        const index = seen;
        seen += 1;
        return refuse(index)
          ? {
              status: "rejected",
              error: { code: "invalid_event", message: "refused by the stub", httpStatus: 400 }
            }
          : { status: "accepted" };
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { results } }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const diagnostics: Diagnostic[] = [];
  try {
    const recorder = createRecorder({
      endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      apiKey: "wsk_test",
      serviceName: "sweep",
      environment: "development",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      ...settings
    });
    await record(recorder);
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

const posting = (recorder: Recorder, id = "4567"): Journey =>
  recorder.startJourney({ entity: { type: "job_posting", id } });

const labels = (events: Record<string, unknown>[]): unknown[] =>
  events.map((event) => event["journeyLabel"]);

const valid = (event: Record<string, unknown>): boolean =>
  journeyEventSchema.safeParse(event).success;

describe("journey.label", () => {
  it("records nothing itself, and is carried on every later event of the journey", async () => {
    const { events, counters } = await capture(async (recorder) => {
      const journey = posting(recorder);
      journey.record({ operation: "received", name: "before" });
      journey.label("Mirantis · Senior SWE, AI Infra");
      journey.transform("map", { a: 1 }, () => ({ b: 1 }));
      await journey.persist("save", { b: 1 }, () => Promise.resolve("ok"));
      journey.identify({ postingId: "4567" });
      journey.fail("notify", new Error("smtp down"));
      journey.finish();
    });

    expect(events.map((event) => event["name"])).toEqual([
      "before",
      "map",
      "save",
      "identify",
      "notify",
      "finish"
    ]);
    expect(events[0]).not.toHaveProperty("journeyLabel");
    expect(labels(events.slice(1))).toEqual(
      Array.from({ length: 5 }, () => "Mirantis · Senior SWE, AI Infra")
    );
    expect(events.every(valid)).toBe(true);
    expect(counters.sent).toBe(6);
  });

  it("carries the latest label set, from the event after it was set", async () => {
    const { events } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label("first");
      journey.record({ operation: "received", name: "one" });
      journey.label("second");
      journey.record({ operation: "transformed", name: "two" });
    });
    expect(labels(events)).toEqual(["first", "second"]);
  });

  it("belongs to the journey object, not to its id", async () => {
    // Labels live on the handle: another handle for the same journey, such as
    // one continued from a propagated context, carries none until it sets one.
    const { events } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label("labelled");
      const again = recorder.continueJourney(journey.context());
      again.record({ operation: "consumed", name: "other-handle" });
      journey.record({ operation: "received", name: "same-handle" });
    });
    expect(events[0]).not.toHaveProperty("journeyLabel");
    expect(events[1]?.["journeyLabel"]).toBe("labelled");
  });

  it("is accepted by startJourney, before the identify its aliases make", async () => {
    const { events } = await capture((recorder) => {
      const journey = recorder.startJourney({
        entity: { type: "job_posting", id: "4567" },
        aliases: { postingId: "4567" },
        displayableAliases: ["postingId"],
        label: "Mirantis"
      });
      journey.record({ operation: "received", name: "sweep" });
    });
    expect(events.map((event) => event["operation"])).toEqual(["identified", "received"]);
    expect(labels(events)).toEqual(["Mirantis", "Mirantis"]);
  });

  it("keeps a label of exactly 200 astral characters whole", async () => {
    const longest = "𝄞".repeat(MAX_JOURNEY_LABEL_LENGTH);
    const { events, counters } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label(longest);
      journey.record({ operation: "received", name: "r" });
    });
    expect(events[0]?.["journeyLabel"]).toBe(longest);
    expect(counters.payloadsTruncated).toBe(0);
    expect(valid(events[0] ?? {})).toBe(true);
  });

  it("cuts a longer label to 199 code points and an ellipsis, never splitting a pair", async () => {
    // 204 code units, 201 code points of which 199 fit. The astral character
    // straddles code unit 199, so a cut by code units would split it.
    const label = `${"a".repeat(198)}😀tail`;
    const { events, diagnostics, counters } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label(label);
      journey.record({ operation: "received", name: "one" });
      journey.record({ operation: "transformed", name: "two" });
    });

    const cut = `${"a".repeat(198)}😀…`;
    expect(labels(events)).toEqual([cut, cut]);
    expect(Array.from(cut)).toHaveLength(MAX_JOURNEY_LABEL_LENGTH);
    expect(cut.isWellFormed()).toBe(true);
    expect(events.every(valid)).toBe(true);

    // Reported once, when it was set, however many events carry it.
    expect(counters.payloadsTruncated).toBe(1);
    const reported = diagnostics.filter((d) => d.kind === "payload_truncated");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.detail).toEqual({
      field: "journeyLabel",
      strings: 1,
      charactersRemoved: 4
    });
    // The label is the host's text; the reason does not quote it. The count is
    // in code units, as the detail's is, and the reason says so.
    expect(reported[0]?.reason).not.toContain("tail");
    expect(reported[0]?.reason).toContain("4 UTF-16 code units");
    expect(counters.sent).toBe(2);
  });

  it("cuts a label of 201 astral characters to 199 of them and an ellipsis", async () => {
    const { events } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label("𝄞".repeat(MAX_JOURNEY_LABEL_LENGTH + 1));
      journey.record({ operation: "received", name: "r" });
    });
    expect(events[0]?.["journeyLabel"]).toBe(`${"𝄞".repeat(199)}…`);
    expect(valid(events[0] ?? {})).toBe(true);
  });

  it("is kept whole when it tips the event over the budget, and the input goes instead", async () => {
    // Measure the event without a label, then allow a little less than a
    // 200-character astral label adds (800 bytes). The event fitted before the
    // label; with it, the size check has to omit something, and the label is
    // not something it omits.
    const record = (journey: Journey): void => {
      journey.record({ operation: "received", name: "r", input: { note: "n".repeat(2_000) } });
    };
    const unlabelled = await capture((recorder) => {
      record(posting(recorder));
    });
    const bytes = Buffer.byteLength(
      JSON.stringify({ protocolVersion: "0.1", event: unlabelled.events[0] }),
      "utf8"
    );

    const longest = "𝄞".repeat(MAX_JOURNEY_LABEL_LENGTH);
    const { events, diagnostics, counters } = await capture(
      (recorder) => {
        const journey = posting(recorder);
        journey.label(longest);
        record(journey);
      },
      () => false,
      { maxEventBytes: bytes + 100 }
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.["journeyLabel"]).toBe(longest);
    expect(events[0]?.["input"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect(valid(events[0] ?? {})).toBe(true);
    expect(counters.payloadsOmitted).toBe(1);
    expect(counters.payloadsTruncated).toBe(0);
    expect(counters.sent).toBe(1);
    expect(diagnostics.find((d) => d.kind === "payload_omitted")).toMatchObject({
      code: "too_large",
      detail: { field: "input" }
    });
  });

  it.each([
    ["an empty string", ""],
    ["a lone NUL, empty once made storable", "\u0000"],
    ["only spaces", "   "],
    ["only whitespace of other kinds", "\t\n\u00a0\u2003\ufeff"],
    ["whitespace around a NUL", " \u0000 "],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { text: "Mirantis" }],
    ["a String object", new String("Mirantis")],
    ["a symbol", Symbol("label")]
  ])("drops %s with a diagnostic, and still sends the event", async (_what, value) => {
    const { events, diagnostics, counters } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label(value as string);
      journey.record({ operation: "received", name: "r" });
    });
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("journeyLabel");
    expect(valid(events[0] ?? {})).toBe(true);
    expect(counters.sent).toBe(1);
    expect(counters.keysDropped).toBe(1);
    expect(counters.captureErrors).toBe(0);
    expect(diagnostics.find((d) => d.kind === "key_dropped")?.detail).toEqual({
      field: "journeyLabel",
      keys: 1
    });
  });

  it("leaves an earlier label in place when a later one is dropped", async () => {
    // The server never clears a label, so the SDK does not either.
    const { events } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label("kept");
      journey.label("");
      journey.record({ operation: "received", name: "r" });
    });
    expect(events[0]?.["journeyLabel"]).toBe("kept");
  });

  it("repairs what PostgreSQL cannot store rather than losing the event", async () => {
    const { events } = await capture((recorder) => {
      const journey = posting(recorder);
      journey.label("Mir\u0000antis \uD83D");
      journey.record({ operation: "received", name: "r" });
    });
    expect(events[0]?.["journeyLabel"]).toBe("Mirantis \uFFFD");
  });

  it("never throws into the host, whatever it is given", async () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("proxy get");
        },
        getPrototypeOf: () => {
          throw new Error("proxy prototype");
        },
        ownKeys: () => {
          throw new Error("proxy keys");
        }
      }
    );
    const throwingToString = {
      toString: (): string => {
        throw new Error("toString");
      },
      [Symbol.toPrimitive]: (): string => {
        throw new Error("toPrimitive");
      }
    };
    const throwingGetter = {
      entity: { type: "job_posting", id: "4567" },
      get label(): string {
        throw new Error("label getter");
      }
    };
    const throwingEverything = new Proxy(
      {},
      {
        get: () => {
          throw new Error("options get");
        },
        has: () => {
          throw new Error("options has");
        }
      }
    );

    const { events, counters } = await capture((recorder) => {
      const journey = posting(recorder);
      expect(() => {
        journey.label(hostile as unknown as string);
        journey.label(throwingToString as unknown as string);
      }).not.toThrow();
      journey.record({ operation: "received", name: "after-hostile-labels" });

      let started: Journey | undefined;
      expect(() => {
        started = recorder.startJourney(throwingGetter);
      }).not.toThrow();
      started?.record({ operation: "received", name: "after-throwing-getter" });

      let fallback: Journey | undefined;
      expect(() => {
        fallback = recorder.startJourney(
          throwingEverything as unknown as Parameters<Recorder["startJourney"]>[0]
        );
      }).not.toThrow();
      fallback?.record({ operation: "received", name: "after-hostile-options" });

      expect(() => {
        recorder.startJourney(undefined as unknown as Parameters<Recorder["startJourney"]>[0]);
      }).not.toThrow();
    });

    expect(events.map((event) => event["name"])).toEqual([
      "after-hostile-labels",
      "after-throwing-getter",
      "after-hostile-options"
    ]);
    expect(events.every((event) => !("journeyLabel" in event))).toBe(true);
    expect(events.every(valid)).toBe(true);
    // The two hostile labels were not strings, so they were dropped unread.
    expect(counters.keysDropped).toBe(2);
    expect(counters.sent).toBe(3);
  });

  it("keeps every recorded event accounted for as sent, rejected, or dropped", async () => {
    const values: unknown[] = [
      "short",
      "",
      "x".repeat(500),
      7,
      `${"b".repeat(199)}😀😀`,
      "\u0000",
      "last"
    ];
    let recorded = 0;
    const { events, counters } = await capture(
      (recorder) => {
        for (const [index, value] of values.entries()) {
          const journey = posting(recorder, String(index));
          journey.label(value as string);
          for (let step = 0; step < 3; step += 1) {
            journey.record({ operation: "transformed", name: `step-${String(step)}` });
            recorded += 1;
          }
        }
      },
      (index) => index % 4 === 0
    );

    expect(counters.sent + counters.rejected + counters.dropped).toBe(recorded);
    expect(counters.rejected).toBeGreaterThan(0);
    expect(counters.sent).toBeGreaterThan(0);
    expect(events).toHaveLength(recorded);
    expect(events.every(valid)).toBe(true);
    expect(counters.payloadsTruncated).toBe(2);
    expect(counters.keysDropped).toBe(3);
  });
});

describe("labels through recorder.across", () => {
  it("carries each journey's own label, read when the event is recorded", async () => {
    const { events } = await capture((recorder) => {
      const first = posting(recorder, "p1");
      const second = posting(recorder, "p2");
      const unlabelled = posting(recorder, "p3");
      const byContext = posting(recorder, "p4");
      first.label("First posting");
      byContext.label("Only its handle knows this");

      const group = recorder.across([first, second, unlabelled, byContext.context()]);
      // Set after the group was made: the group reads the journey's label as
      // each event is recorded, as the journey itself does.
      second.label("Second posting");
      group.persist("write-digest", { lines: 4 }, () => "digest.md");
    });

    const byEntity = new Map(
      events.map((event) => [(event["entity"] as { id: string }).id, event["journeyLabel"]])
    );
    expect(byEntity).toEqual(
      new Map([
        ["p1", "First posting"],
        ["p2", "Second posting"],
        ["p3", undefined],
        // Named by context, not by handle: a context carries no label.
        ["p4", undefined]
      ])
    );
    expect(events.every(valid)).toBe(true);
  });

  it("uses the first handle's label when one journey is named twice", async () => {
    const { events } = await capture((recorder) => {
      const journey = posting(recorder, "p1");
      journey.label("From the first handle");
      const other = recorder.continueJourney(journey.context());
      other.label("From the second handle");
      recorder.across([journey, other]).record({ operation: "persisted", name: "w" });
    });
    expect(labels(events)).toEqual(["From the first handle"]);
  });

  it("does not offer label on a group", async () => {
    await capture((recorder) => {
      const group = recorder.across([posting(recorder)]);
      expect("label" in group).toBe(false);
    });
  });
});
