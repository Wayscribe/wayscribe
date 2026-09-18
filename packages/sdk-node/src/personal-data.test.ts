import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder, type Recorder, type RecorderConfig } from "./index.js";
import { forgetPersonalDataWarnings } from "./personal-data.js";

/**
 * A label and a displayable alias are stored, shown and searched in plain text
 * and are never redacted, so neither should hold personal data. Nothing said
 * so at the time it was written (F-006, F-012).
 *
 * ADR-055's pattern exactly: warn, never redact on a guess, and never alter
 * the value. The check is deliberately dumb, an email shape and an
 * international phone shape, because a clever one that is wrong changes what a
 * reader sees for no gain.
 */

const base = {
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "development"
};

interface Run {
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  printed: string[];
}

async function capture(
  run: (recorder: Recorder) => Promise<void> | void,
  extra: Partial<RecorderConfig> = {}
): Promise<Run> {
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
  const printed: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const diagnostics: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    onDiagnostic: (d) => diagnostics.push(d),
    ...extra
  });
  try {
    await run(recorder);
    await recorder.shutdown({ timeoutMs: 5_000 });
  } finally {
    spy.mockRestore();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  return { events, diagnostics, printed };
}

const warnings = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.kind === "personal_data_in_public_value");

beforeEach(() => {
  forgetPersonalDataWarnings();
});

describe("personal data in a journey label", () => {
  it("warns once, names the field, and never alters the label", async () => {
    const label = "Acme Corp · jane.doe@acme.com";
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "lead", id: "1" }, label })
        .record({ operation: "received", name: "r" });
    });
    expect(events[0]?.["journeyLabel"]).toBe(label);
    expect(warnings(diagnostics)).toEqual([
      {
        kind: "personal_data_in_public_value",
        code: "personal_data_shape",
        reason: expect.stringContaining("email address") as string,
        detail: { field: "journeyLabel", shape: "email" }
      }
    ]);
    // The value is the point of the warning and is never quoted back.
    expect(JSON.stringify(diagnostics)).not.toContain("jane.doe@acme.com");
  });

  it("warns about an international phone number too", async () => {
    const { diagnostics } = await capture((recorder) => {
      recorder.startJourney({ entity: { type: "lead", id: "1" }, label: "Acme · +1 555 010 9999" });
    });
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "journeyLabel", shape: "phone" }
    ]);
  });

  it("says nothing about a label that looks like neither", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({
        entity: { type: "lead", id: "1" },
        label: "Acme Corp · Senior Platform Engineer"
      });
      journey.label("invoice 2026-09-17 · 12 items · +3 more");
      journey.label("build 1.4.2 @ 27f4d64");
    });
    expect(warnings(diagnostics)).toEqual([]);
  });

  it.each([
    // A `+` that follows other characters is not a dialling code: semver build
    // metadata, a digest, and a long digit run after a dot all have one.
    ["semver build metadata", "release 1.2.3+20130313144700"],
    ["a digest", "image sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["a base64 digest with a plus", "sha256:aB+cdEfGhIjKlMnOpQrStUvWxYz0123456789+/aB"],
    ["a long digit run after a dot", "batch 4.20130313144700"],
    ["an offset timestamp", "started 2026-09-17T12:00:00+01:00"],
    ["an order total", "order 4008 · 12 items · 1 999 000 cents"]
  ])("says nothing about %s", async (_what, label) => {
    const { diagnostics } = await capture((recorder) => {
      recorder.startJourney({ entity: { type: "lead", id: "1" }, label });
    });
    expect(warnings(diagnostics)).toEqual([]);
  });

  it("still warns for a dialling code at the start, after a space, or in brackets", async () => {
    for (const label of ["+44 20 7946 0958", "call +44 20 7946 0958", "(+44 20 7946 0958)"]) {
      forgetPersonalDataWarnings();
      const { diagnostics } = await capture((recorder) => {
        recorder.startJourney({ entity: { type: "lead", id: "1" }, label });
      });
      expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
        { field: "journeyLabel", shape: "phone" }
      ]);
    }
  });

  it("warns once per process and shape, however many labels hold one", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
      journey.label("one · a@b.co");
      journey.label("two · c@d.co");
      journey.label("three · +1 555 010 9999");
    });
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "journeyLabel", shape: "email" },
      { field: "journeyLabel", shape: "phone" }
    ]);
  });

  it("prints one line per process and shape with logDiagnostics off, never the value", async () => {
    const { printed } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
      journey.label("one · jane.doe@acme.com");
      journey.label("two · john.roe@acme.com");
    });
    const lines = printed.filter((line) => line.includes("personal_data_in_public_value"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("once per process");
    expect(lines.join("\n")).not.toContain("jane.doe");
  });
});

describe("personal data in a displayable alias", () => {
  it("warns for a value the caller marked displayable, and sends it unchanged", async () => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "lead", id: "1" } })
        .identify(
          { recruiterEmail: "jane.doe@acme.com", postingId: "p1" },
          { displayableAliases: ["recruiterEmail"] }
        );
    });
    expect((events[0]?.["aliases"] as Record<string, string>)["recruiterEmail"]).toBe(
      "jane.doe@acme.com"
    );
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "displayableAliases", shape: "email" }
    ]);
  });

  it("says nothing about an alias that is not displayable, because it is masked when read", async () => {
    const { diagnostics } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "lead", id: "1" } })
        .identify({ recruiterEmail: "jane.doe@acme.com" });
    });
    expect(warnings(diagnostics)).toEqual([]);
  });

  it("warns for one stated through startJourney and through record", async () => {
    const { diagnostics } = await capture((recorder) => {
      recorder.startJourney({
        entity: { type: "lead", id: "1" },
        aliases: { contact: "+1 555 010 9999" },
        displayableAliases: ["contact"]
      });
    });
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "displayableAliases", shape: "phone" }
    ]);
  });

  it("shares the once-per-process rule with the label", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({
        entity: { type: "lead", id: "1" },
        label: "Acme · jane@acme.com"
      });
      journey.identify({ email: "john@acme.com" }, { displayableAliases: ["email"] });
    });
    expect(warnings(diagnostics)).toHaveLength(1);
  });

  it("cannot break the call, whatever the aliases hold", async () => {
    const { events } = await capture((recorder) => {
      expect(() => {
        recorder.startJourney({ entity: { type: "lead", id: "1" } }).identify(
          { a: "jane@acme.com" },
          {
            displayableAliases: [null, "a"] as unknown as string[]
          }
        );
      }).not.toThrow();
    });
    expect(events).toHaveLength(1);
  });
});
