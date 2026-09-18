import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder, type Recorder, type RecorderConfig } from "./index.js";
import { forgetPersonalDataWarnings, personalDataShapeOf } from "./personal-data.js";

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

  it("warns once per field: a label that warned does not silence an alias", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({
        entity: { type: "lead", id: "1" },
        label: "Acme · jane@acme.com"
      });
      journey.identify({ email: "john@acme.com" }, { displayableAliases: ["email"] });
      journey.identify({ email: "jo@acme.com" }, { displayableAliases: ["email"] });
    });
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "journeyLabel", shape: "email" },
      { field: "displayableAliases", shape: "email" }
    ]);
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

describe("personal data in an error message (F-041)", () => {
  it("warns for a FailureReason message, and sends it unchanged", async () => {
    const message = "avery.example@northwind.example is over its limit.";
    const { events, diagnostics } = await capture(async (recorder) => {
      await recorder
        .startJourney({ entity: { type: "lead", id: "1" } })
        .deliver("push-crm", {}, () => Promise.resolve({ status: 429 }), {
          isFailure: () => ({ message, code: "http_429" })
        });
    });
    expect((events[0]?.["error"] as { message: string }).message).toBe(message);
    expect(warnings(diagnostics)).toEqual([
      {
        kind: "personal_data_in_public_value",
        code: "personal_data_shape",
        reason: expect.stringContaining("An error message") as string,
        detail: { field: "errorMessage", shape: "email" }
      }
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("avery.example");
  });

  it("warns for a string isFailure returns, a thrown error, record() and fail()", async () => {
    for (const run of [
      (recorder: Recorder) => {
        recorder
          .startJourney({ entity: { type: "lead", id: "1" } })
          .transform("t", 1, () => 2, { isFailure: () => "call +44 20 7946 0958 back" });
      },
      (recorder: Recorder) => {
        expect(() =>
          recorder.startJourney({ entity: { type: "lead", id: "1" } }).transform("t", 1, () => {
            throw new Error("no account for +44 20 7946 0958");
          })
        ).toThrow();
      },
      (recorder: Recorder) => {
        recorder.startJourney({ entity: { type: "lead", id: "1" } }).record({
          operation: "failed",
          name: "r",
          error: { message: "no account for +44 20 7946 0958" }
        });
      },
      (recorder: Recorder) => {
        recorder
          .startJourney({ entity: { type: "lead", id: "1" } })
          .fail("dead-letter", new Error("no account for +44 20 7946 0958"));
      }
    ]) {
      forgetPersonalDataWarnings();
      const { events, diagnostics } = await capture(run);
      expect(events).toHaveLength(1);
      expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
        { field: "errorMessage", shape: "phone" }
      ]);
    }
  });

  it("says nothing about an error message that looks like neither", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
      journey.transform("t", 1, () => 2, { isFailure: () => "HubSpot answered 429 to the create" });
      journey.record({ operation: "failed", name: "r", error: { message: "timeout after 30s" } });
    });
    expect(warnings(diagnostics)).toEqual([]);
  });

  it("examines the message as it is sent, after masking", async () => {
    // Masking takes the assignment's value, address and all, so what is sent
    // holds no address; the raw text would have warned.
    const message = "login refused for password=jane.doe@acme.com";
    expect(personalDataShapeOf(message)).toBe("email");
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "lead", id: "1" } })
        .record({ operation: "failed", name: "r", error: { message } });
    });
    const sent = (events[0]?.["error"] as { message: string }).message;
    expect(sent).not.toContain("jane.doe");
    expect(warnings(diagnostics)).toEqual([]);
  });

  it("does not examine the stack", async () => {
    const { diagnostics } = await capture((recorder) => {
      recorder.startJourney({ entity: { type: "lead", id: "1" } }).record({
        operation: "failed",
        name: "r",
        error: { message: "timeout", stack: "Error: timeout\n    at jane@acme.com" }
      });
    });
    expect(warnings(diagnostics)).toEqual([]);
  });

  it("warns once per process for error messages, apart from the label", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({
        entity: { type: "lead", id: "1" },
        label: "Acme · jane@acme.com"
      });
      journey.record({ operation: "failed", name: "r", error: { message: "for john@acme.com" } });
      journey.record({ operation: "failed", name: "r", error: { message: "for jo@acme.com" } });
    });
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "journeyLabel", shape: "email" },
      { field: "errorMessage", shape: "email" }
    ]);
  });

  it("cannot cost the step, whatever the error holds", async () => {
    const throwing = (): never => {
      throw new Error("no");
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const { events } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
      // A reason whose message getter throws, and one that is a revoked Proxy.
      journey.transform("getter", 1, () => 2, {
        isFailure: () => Object.defineProperty({}, "message", { get: throwing, enumerable: true })
      });
      journey.transform("revoked", 1, () => 2, { isFailure: () => revoked.proxy });
      // A thrown error whose message getter throws. Caught by hand, because
      // `toThrow` reads the message too.
      const hostile = Object.defineProperty(new Error("x"), "message", { get: throwing });
      let caught: unknown;
      try {
        journey.transform("thrown", 1, () => {
          throw hostile;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(hostile);
      // A message that is not a string.
      journey.record({ operation: "failed", name: "number", error: { message: 7 as never } });
    });
    expect(events.map((event) => event["name"])).toEqual(["getter", "revoked", "thrown", "number"]);
  });
});

describe("what the shapes do not match (F-041 review)", () => {
  // Error text is full of `@` and `+` that are not personal data, and a false
  // positive costs more than noise: it spends the warning for its field.
  it.each([
    ["the SDK's own masked URL", "connect to postgres://[REDACTED]@db.internal:5432/leads"],
    ["URL userinfo left unmasked", "connect to postgres://leads@db.internal:5432/leads"],
    ["a module path", "Cannot find module '/app/node_modules/@aws-sdk/client-s3/dist/index.js'"],
    ["a versioned package path", "at lodash@4.17.21/fp.js"],
    [
      "an npm scoped package with a version",
      "resolved @babel/core@7.24.0 from @types/node@20.11.5"
    ],
    ["a scoped package path", "/srv/node_modules/@scope/pkg@1.2.3/lib/index.js"],
    ["a git remote", "fatal: could not read from git@github.com:org/repo.git"],
    ["an ssh target with a path", "scp deploy@build.example.com:/srv/app failed"],
    ["an ssh error naming user@host", "deploy@build.example.com: Permission denied (publickey)."],
    [
      "a Docker image with a digest",
      "pull registry.example.com/team/app@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    ],
    ["an image digest after a name", "app@sha256:abc123.def"],
    ["a JavaScript date", "Fri Sep 18 14:00:00 +0000 2026"],
    ["a timezone offset in a log line", "at 2026-09-18 14:00:00 +0100 (CET) retrying"]
  ])("does not flag %s", (_what, text) => {
    expect(personalDataShapeOf(text)).toBeUndefined();
  });

  it.each([
    ["an address alone", "jane.doe@acme.com", "email"],
    ["an address at the end of a sentence", "no account for jane.doe@acme.com.", "email"],
    ["an address in angle brackets", "From: Jane <jane.doe@acme.com>", "email"],
    ["an address after a colon", "email:jane.doe@acme.com refused", "email"],
    ["an address after an equals sign", "user=jane.doe@acme.com not found", "email"],
    ["an address in quotes", "unknown recipient 'jane.doe@acme.com'", "email"],
    ["a number with a dialling code", "call +44 20 7946 0958", "phone"],
    ["a number written together", "sms to +442079460958 failed", "phone"]
  ])("still flags %s", (_what, text, shape) => {
    expect(personalDataShapeOf(text)).toBe(shape);
  });
});

describe("one field never silences another (F-041 review)", () => {
  it("warns for a label after an error message already warned for the same shape", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
      journey.record({ operation: "failed", name: "r", error: { message: "for john@acme.com" } });
      journey.label("Acme · jane@acme.com");
      journey.identify({ email: "jo@acme.com" }, { displayableAliases: ["email"] });
      journey.record({ operation: "failed", name: "r", error: { message: "for jo@acme.com" } });
      journey.label("Acme · jo@acme.com");
    });
    expect(warnings(diagnostics).map((d) => d.detail)).toEqual([
      { field: "errorMessage", shape: "email" },
      { field: "journeyLabel", shape: "email" },
      { field: "displayableAliases", shape: "email" }
    ]);
  });

  it("prints one line per field and shape with logDiagnostics off", async () => {
    const { printed } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });
      journey.record({ operation: "failed", name: "r", error: { message: "for john@acme.com" } });
      journey.label("Acme · jane@acme.com");
      journey.label("Acme · jo@acme.com");
    });
    const lines = printed.filter((line) => line.includes("personal_data_in_public_value"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("An error message");
    expect(lines[1]).toContain("A journey label");
  });
});

describe("the telephone shape (ADR-063 decision 5)", () => {
  // A number written in a field, `phone=+1...`, was missed because the `+`
  // followed `=`, and a signed count was flagged because any 8 to 15 digits
  // after a well-placed `+` counted.
  it.each([
    ["a number after an equals sign", "phone=+19195551234"],
    ["a number after a colon", "tel:+19195551234"],
    ["a number in JSON", '{"phone":"+19195551234"}'],
    ["a number written with spaces", "+1 919 555 1234"],
    ["a dialling code in brackets", "(+44) 20 7946 0958"],
    ["a number after a comma", "contacts: jane,+442079460958"],
    ["a number after a semicolon", "to;+442079460958"],
    ["a number in single quotes", "unknown recipient '+442079460958'"],
    ["a number after a closing bracket", "(mobile)+442079460958"],
    ["a number in angle brackets", "SMS <+442079460958> failed"],
    ["a number after a greater-than sign", "sent >+442079460958"],
    ["a number after an opening square bracket", "[+44 20 7946 0958]"],
    ["an unbroken run of fifteen digits", "call +123456789012345"],
    ["eight digits with a separator", "call +12 3456 78"],
    ["nine digits with a separator", "ring +12 345 6789"]
  ])("flags %s", (_what, text) => {
    expect(personalDataShapeOf(text)).toBe("phone");
  });

  it.each([
    ["a signed byte count", "Received +12345678 bytes"],
    ["a signed count of nine digits", "delta +123456789 rows"],
    ["a count after an equals sign", "delta=+123456789"],
    ["a count after a colon", "bytes:+12345678"],
    ["a short count", "+3 more"],
    ["semver build metadata", "1.2.3+20130313144700"],
    ["an offset timestamp", "2026-09-17T12:00:00+01:00"],
    ["a JavaScript date", "Fri Sep 18 14:00:00 +0000 2026"],
    ["a timezone offset after a colon", "zone:+0100 2026"],
    ["a plus after a letter", "abc+12345678901"],
    ["a plus after a digit", "4+12345678901"],
    ["a plus after a dot", "v.+12345678901"],
    ["a plus after a closing square bracket", "[x]+12345678901"],
    ["sixteen digits", "card +1234567890123456"],
    ["sixteen digits with separators", "+1234 5678 9012 3456"],
    ["seven digits with a separator", "call +123 4567"],
    ["a trailing separator after eight digits", "+12345678 - done"]
  ])("does not flag %s", (_what, text) => {
    expect(personalDataShapeOf(text)).toBeUndefined();
  });

  it.each([
    ["UTC", "Fri Sep 18 14:00:00 +0000 2026"],
    ["India", "Fri Sep 18 14:00:00 +0530 2026"],
    ["Nepal", "Fri Sep 18 14:00:00 +0545 2026"],
    ["Kiribati", "Fri Sep 18 14:00:00 +1400 2026"],
    ["a quarter-hour offset", "Fri Sep 18 14:00:00 +1245 2026"]
  ])("skips a real timezone offset: %s", (_what, text) => {
    expect(personalDataShapeOf(text)).toBeUndefined();
  });

  it.each([
    ["four digits that are not an offset's minutes", "call +1234 5678"],
    ["a German number", "call +4930 1234567"],
    ["an Irish number", "call +3531 234 5678"],
    ["hours past 14", "call +1500 2026"],
    ["minutes that are not a quarter hour", "call +0110 2026"]
  ])("finds a number that starts with four digits: %s", (_what, text) => {
    expect(personalDataShapeOf(text)).toBe("phone");
  });

  it(`stays linear on adversarial input up to the examined length, at most ${String(GROWTH_LIMIT)} times dearer a character at four times the size`, async () => {
    const results = await growthInChild(
      ADVERSARIAL.map(([, build]) => ({ small: build(256), large: build(1_024) }))
    );
    for (const [index, [name]] of ADVERSARIAL.entries()) {
      // Linear reads about 1; backtracking over the candidate reads 4 or more,
      // or runs out of the child's budget. Measured in processor time, with
      // the two sizes alternating (tests/support/timing.ts), so a busy machine
      // stretches neither: this was a wall-clock bound of 5 ms a call.
      const result = results[index];
      expect(result?.error, name).toBeUndefined();
      expect(result?.ratio, `${name}: ${result?.detail ?? ""}`).toBeLessThanOrEqual(GROWTH_LIMIT);
    }
  }, 60_000);
});

/** Per character, how much dearer 1,024 characters may be than 256. */
const GROWTH_LIMIT = 2;

/** Inputs up to the examined length that would make a backtracking rule slow, by size. */
const ADVERSARIAL: [string, (size: number) => string][] = [
  ["a run of plus signs", (size) => "+".repeat(size)],
  ["equals and plus", (size) => "=+".repeat(size / 2)],
  ["opened groups", (size) => "(+1 ".repeat(size / 4)],
  ["spaced digits ending in a letter", (size) => `+${"1 ".repeat((size - 2) / 2)}x`],
  ["a plus and opening brackets", (size) => `+${"(".repeat(size - 1)}`],
  ["colon-led short numbers", (size) => ":+1234567".repeat(Math.floor(size / 9))],
  [
    "a long word before a number",
    (size) => `${"a".repeat(size - 24)}=+1234567890123`.slice(0, size)
  ],
  ["plus, hyphen and space", (size) => "+- ".repeat(Math.floor(size / 3))]
];

/** Wall-clock budget of each comparison in the child. */
const COMPARISON_BUDGET_MS = 2_000;

/** How long the whole timed run may take before the child is killed. */
const CHILD_DEADLINE_MS = 20_000;

interface ChildResult {
  ratio?: number;
  detail?: string;
  error?: string;
}

/**
 * The growth of `personalDataShapeOf` from each `small` input to its `large`
 * one, measured in a child process that is killed at a deadline.
 *
 * In a child, not here: a regular expression that backtracks cannot be
 * interrupted from the thread running it, so a regression timed in-process
 * hangs the suite rather than failing it. The module and the timing helper
 * are bundled from source with esbuild, as `bench/build.mjs` does, so the
 * child runs this code.
 */
async function growthInChild(
  inputs: readonly { small: string; large: string }[]
): Promise<ChildResult[]> {
  const directory = mkdtempSync(join(tmpdir(), "wayscribe-phone-"));
  try {
    const entry = join(directory, "entry.mjs");
    writeFileSync(
      entry,
      `import { personalDataShapeOf } from ${JSON.stringify(fileURLToPath(new URL("./personal-data.ts", import.meta.url)))};
import { describeComparison, growth } from ${JSON.stringify(fileURLToPath(new URL("../../../tests/support/timing.ts", import.meta.url)))};
const inputs = JSON.parse(process.argv[2]);
const out = inputs.map(({ small, large }) => {
  try {
    const result = growth(
      personalDataShapeOf,
      { input: small, units: small.length },
      { input: large, units: large.length },
      ${String(GROWTH_LIMIT)},
      ${String(COMPARISON_BUDGET_MS)}
    );
    return { ratio: result.ratio, detail: describeComparison(result) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
process.stdout.write(JSON.stringify(out));
`
    );
    const runner = join(directory, "run.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      conditions: ["development"],
      outfile: runner,
      logLevel: "error"
    });
    const result = spawnSync(process.execPath, [runner, JSON.stringify(inputs)], {
      encoding: "utf8",
      timeout: CHILD_DEADLINE_MS,
      killSignal: "SIGKILL"
    });
    if (result.error !== undefined || result.signal !== null) {
      throw new Error(
        `The telephone shape did not finish ${String(inputs.length)} comparisons within ${String(CHILD_DEADLINE_MS)} ms (${String(result.signal ?? result.error?.message)}): it backtracks.`
      );
    }
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ChildResult[];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
