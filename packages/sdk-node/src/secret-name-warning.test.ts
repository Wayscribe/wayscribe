import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Journey, type RecorderConfig } from "./index.js";
import { forgetSecretNameWarnings } from "./secret-names.js";

/**
 * A kept value under a name that reads as a secret is warned about, once per
 * name, whatever `logDiagnostics` says, and the event is sent unchanged
 * (ADR-055, SDK-61, SDK-62).
 */

const events: Record<string, unknown>[] = [];
let server: Server;
let endpoint = "";

beforeAll(async () => {
  server = createServer((incoming, response) => {
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
  endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  events.length = 0;
  forgetSecretNameWarnings();
});

interface Run {
  diagnostics: Diagnostic[];
  counters: Counters;
  printed: string[];
}

async function run(
  record: (journey: Journey) => void,
  settings: Partial<RecorderConfig> = {}
): Promise<Run> {
  const printed: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const diagnostics: Diagnostic[] = [];
  try {
    const recorder = createRecorder({
      endpoint,
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      ...settings
    });
    record(recorder.startJourney({ entity: { type: "customer", id: "1" } }));
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    return { diagnostics, counters, printed: printed.filter((line) => !line.includes("http:")) };
  } finally {
    spy.mockRestore();
  }
}

const warnings = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.kind === "unredacted_secret_name");

const VALUE = "cred-value-7f3a91c2";

describe("the unredacted secret-name warning", () => {
  it("reports the name and its path, never the value, and sends the event unchanged", async () => {
    const input = {
      sessionCredential: VALUE,
      password: "hunter2",
      lines: [{ settings: { authToken: "tok-value-8b1d" } }]
    };
    const result = await run((journey) => {
      journey.record({ operation: "received", name: "webhook", input });
    });

    const found = warnings(result.diagnostics);
    expect(found.map((one) => one.detail)).toEqual([
      { field: "input", name: "sessionCredential", path: "input.sessionCredential" },
      { field: "input", name: "authToken", path: "input.lines[*].settings.authToken" }
    ]);
    expect(found[0]?.reason).toContain('"sessionCredential" (at input.sessionCredential)');
    expect(found[1]?.reason).toContain('"authToken" (at input.lines[*].settings.authToken)');
    const text = JSON.stringify(result.diagnostics) + result.printed.join("\n");
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain("tok-value-8b1d");

    expect(events).toHaveLength(1);
    expect(events[0]?.["input"]).toEqual({
      sessionCredential: VALUE,
      password: "[REDACTED]",
      lines: [{ settings: { authToken: "tok-value-8b1d" } }]
    });
    expect(result.counters.unredactedSecretNames).toBe(2);
    expect(result.counters.sent).toBe(1);
  });

  it("says how to fix it, naming both options", async () => {
    const result = await run((journey) => {
      journey.record({ operation: "received", name: "webhook", input: { authToken: VALUE } });
    });
    const [warning] = warnings(result.diagnostics);
    expect(warning?.reason).toBe(
      'A field named "authToken" (at input.authToken) looks like a secret and was sent unredacted. ' +
        'If it holds a secret, add "**.authToken" to the redact option; if it does not, add "authToken" to knownSafeNames.'
    );
  });

  it("covers output and metadata", async () => {
    const result = await run((journey) => {
      journey.record({
        operation: "delivered",
        name: "send",
        output: { refresh: { botToken: "x-1" } },
        metadata: { apiSecretKey: "x-2" }
      });
    });
    expect(warnings(result.diagnostics).map((one) => one.detail)).toEqual([
      { field: "output", name: "botToken", path: "output.refresh.botToken" },
      { field: "metadata", name: "apiSecretKey", path: "metadata.apiSecretKey" }
    ]);
  });

  it("reports each folded name once per recorder, wherever it appears", async () => {
    const result = await run((journey) => {
      for (let index = 0; index < 5; index += 1) {
        journey.record({
          operation: "received",
          name: "webhook",
          input: { authToken: "a", nested: { auth_token: "b" } },
          output: { AUTH_TOKEN: "c" }
        });
      }
    });
    expect(warnings(result.diagnostics)).toHaveLength(1);
    expect(result.counters.unredactedSecretNames).toBe(1);
    expect(events).toHaveLength(5);
  });

  it("prints once per process and name with logDiagnostics off", async () => {
    const first = await run((journey) => {
      journey.record({ operation: "received", name: "a", input: { authToken: VALUE } });
      journey.record({ operation: "received", name: "b", input: { sessionCredential: VALUE } });
    });
    expect(first.printed).toHaveLength(2);
    expect(first.printed[0]).toMatch(
      /^\[flight-recorder\] unredacted_secret_name: A field named "authToken" .*printed once per process/
    );
    expect(first.printed.join("\n")).not.toContain(VALUE);

    // A second recorder in the same process reports it and prints nothing.
    const second = await run((journey) => {
      journey.record({ operation: "received", name: "a", input: { authToken: VALUE } });
    });
    expect(warnings(second.diagnostics)).toHaveLength(1);
    expect(second.printed).toEqual([]);
  });

  it("prints every name with logDiagnostics on, even in the same minute", async () => {
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", input: { authToken: VALUE } });
        journey.record({ operation: "received", name: "b", input: { sessionCredential: VALUE } });
        journey.record({ operation: "received", name: "c", input: { card_pin: 1234 } });
      },
      { logDiagnostics: true }
    );
    const lines = result.printed.filter((line) => line.includes("unredacted_secret_name"));
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("printed once per process");
  });

  it("is quiet for a name knownSafeNames lists, which does not stop redaction", async () => {
    const result = await run(
      (journey) => {
        journey.record({
          operation: "received",
          name: "a",
          input: { authToken: "a", session_credential: "b", password: "c" }
        });
      },
      { knownSafeNames: ["auth-token", "sessionCredential", "password"] }
    );
    expect(warnings(result.diagnostics)).toEqual([]);
    expect(result.printed).toEqual([]);
    expect(events[0]?.["input"]).toEqual({
      authToken: "a",
      session_credential: "b",
      password: "[REDACTED]"
    });
  });

  it("is quiet for a name the redact option covers", async () => {
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", input: { x: { authToken: "a" } } });
      },
      { redact: ["**.authToken"] }
    );
    expect(warnings(result.diagnostics)).toEqual([]);
    expect(events[0]?.["input"]).toEqual({ x: { authToken: "[REDACTED]" } });
  });

  it("reports knownSafeNames entries it cannot use, and uses the rest", async () => {
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", input: { authToken: "a" } });
      },
      { knownSafeNames: ["authToken", "", 7] as unknown as string[] }
    );
    const problems = result.diagnostics.filter((one) => one.kind === "configuration_error");
    expect(problems.map((one) => one.reason)).toEqual([
      "knownSafeNames holds entries that are not key names; they are ignored."
    ]);
    expect(warnings(result.diagnostics)).toEqual([]);

    const notAList = await run(() => undefined, {
      knownSafeNames: "authToken" as unknown as string[]
    });
    expect(notAList.diagnostics.map((one) => one.kind)).toEqual(["configuration_error"]);
  });

  it("gives advice that works for a name no redaction rule can name", async () => {
    const result = await run((journey) => {
      journey.record({
        operation: "received",
        name: "a",
        input: { "session.token": VALUE, "keys[0]Token": VALUE }
      });
    });
    const [dotted, bracketed] = warnings(result.diagnostics);
    expect(dotted?.reason).toBe(
      'A field named "session.token" (at input.session.token) looks like a secret and was sent unredacted. ' +
        'No redaction rule can name a key containing ".", "*", "[" or "]": if it holds a secret, rename it or leave it out of what you record; ' +
        'if it does not, add "session.token" to knownSafeNames.'
    );
    expect(bracketed?.reason).toContain("No redaction rule can name a key");
    expect(result.printed.join("\n")).not.toContain('"**.session.token"');
  });

  it("accepts a name no rule can name in knownSafeNames", async () => {
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", input: { "session.token": VALUE } });
      },
      { knownSafeNames: ["session.token"] }
    );
    expect(warnings(result.diagnostics)).toEqual([]);
  });

  it("reports only for a payload that is sent, and keeps the warning for one that is", async () => {
    const chunk = "x".repeat(60_000);
    const quarter = { a: chunk, b: chunk, c: chunk, d: chunk };
    const result = await run((journey) => {
      // Two payloads that each fit and together do not: the larger, which holds
      // the only authToken, is omitted, so nothing under that name was sent.
      journey.record({
        operation: "received",
        name: "a",
        input: { authToken: VALUE, ...quarter },
        output: quarter
      });
      journey.record({
        operation: "received",
        name: "b",
        input: { later: { authToken: VALUE } }
      });
    });
    expect(events[0]?.["input"]).toBe("[PAYLOAD_TOO_LARGE]");
    expect(warnings(result.diagnostics).map((one) => one.detail)).toEqual([
      { field: "input", name: "authToken", path: "input.later.authToken" }
    ]);
    expect(result.printed).toHaveLength(1);
  });

  it("does not report for metadata dropped by the budget", async () => {
    // Metadata that fits a payload's budget and not the event's, once the
    // envelope around it is counted, so the event is sent without it.
    // With a 10,000 byte budget, 9,800 bytes of metadata pass the payload's
    // own check and not the event's.
    const metadata = { authToken: VALUE, d: "x".repeat(9_800) };
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", metadata });
      },
      { maxPayloadBytes: 10_000 }
    );
    expect(result.counters.payloadsOmitted).toBe(1);
    expect(events[0]?.["metadata"]).toBeUndefined();
    expect(warnings(result.diagnostics)).toEqual([]);
  });

  it("keeps no more than a bounded copy of a very long name alive", async () => {
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const kept: Diagnostic[] = [];
    const printed: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    const recorders: unknown[] = [];

    /**
     * Heap still in use after recording 150 events whose single key is a
     * distinct 200 KB name, with the recorder and every diagnostic handed out
     * still reachable. V8 itself keeps some long property names for a while,
     * so the same run with names that do not look secret is the baseline.
     */
    const retainedBy = async (suffix: string, seed: string): Promise<number> => {
      collect();
      const before = process.memoryUsage().heapUsed;
      const recorder = createRecorder({
        endpoint,
        apiKey: "fr_test",
        serviceName: "svc",
        environment: "development",
        onDiagnostic: (diagnostic) => kept.push(diagnostic)
      });
      recorders.push(recorder);
      const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
      for (let index = 0; index < 150; index += 1) {
        // Names that differ only at the start, as an attacker would send them.
        const name = `${seed}${String(index)}${"k".repeat(200_000)}${suffix}`;
        journey.record({ operation: "received", name: "a", input: { [name]: "v" } });
      }
      await recorder.shutdown({ timeoutMs: 5_000 });
      events.length = 0;
      collect();
      return process.memoryUsage().heapUsed - before;
    };

    try {
      const baseline = await retainedBy("Count", "a");
      const warned = await retainedBy("Token", "b");
      expect(warnings(kept)).toHaveLength(100);
      expect(printed.filter((line) => line.includes("unredacted_secret_name"))).toHaveLength(100);
      expect(recorders).toHaveLength(2);
      // Unbounded, the remembered names put the warned run 10 MB above the
      // baseline; bounded, it measured 10 MB below it (V8 keeps names it saw
      // first longer).
      expect(warned - baseline).toBeLessThan(2 * 1024 * 1024);
    } finally {
      spy.mockRestore();
    }
  });

  it("stops remembering names after 100, and keeps sending", async () => {
    const input = Object.fromEntries(
      Array.from({ length: 150 }, (_unused, index) => [`vendor${String(index)}Token`, "t"])
    );
    const result = await run((journey) => {
      journey.record({ operation: "received", name: "a", input });
      journey.record({ operation: "received", name: "a", input });
    });
    expect(warnings(result.diagnostics)).toHaveLength(100);
    expect(result.counters.unredactedSecretNames).toBe(100);
    expect(result.printed).toHaveLength(100);
    expect(events).toHaveLength(2);
  });

  it("cuts a very long name and path before reporting them", async () => {
    const name = `${"x".repeat(500)}Token`;
    const result = await run((journey) => {
      journey.record({ operation: "received", name: "a", input: { [name]: "t" } });
    });
    const [warning] = warnings(result.diagnostics);
    const detail = warning?.detail as { name: string; path: string };
    expect(detail.name.length).toBeLessThanOrEqual(128);
    expect(detail.path.length).toBeLessThanOrEqual(256);
    expect(result.printed[0]?.length).toBeLessThan(700);
  });

  it("changes nothing when onDiagnostic throws", async () => {
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", input: { authToken: "a" } });
      },
      {
        onDiagnostic: () => {
          throw new Error("callback failed");
        }
      }
    );
    expect(events).toHaveLength(1);
    expect(result.counters.captureErrors).toBe(0);
    expect(result.counters.unredactedSecretNames).toBe(1);
  });

  it("captures nothing, and so warns about nothing, in metadata-only mode", async () => {
    const result = await run(
      (journey) => {
        journey.record({ operation: "received", name: "a", input: { authToken: "a" } });
      },
      { captureMode: "metadata-only" }
    );
    expect(warnings(result.diagnostics)).toEqual([]);
  });
});
