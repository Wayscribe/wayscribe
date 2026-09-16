import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Recorder, type RecorderConfig, type WrapOptions } from "./index.js";

/**
 * Every public entry point, given what a plain-JavaScript host can pass:
 * nothing, null, an object whose getters throw, a Proxy that throws on every
 * read. None of it may reach the host (ADR-007, SDK-1, SDK-6).
 *
 * `consume(undefined)`, a throwing getter on `consume`'s options, `null`
 * wrapper options and an unreadable recorder configuration all used to throw.
 */

const hostile = (): object =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error("hostile get");
      },
      has: () => {
        throw new Error("hostile has");
      },
      ownKeys: () => {
        throw new Error("hostile keys");
      },
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile descriptor");
      }
    }
  );

const throwingGetter = <T extends object>(base: T, key: string): T =>
  Object.defineProperty({ ...base }, key, {
    get: () => {
      throw new Error(`${key} getter`);
    },
    enumerable: true
  });

interface Captured {
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  counters: Counters;
}

async function withStub(
  run: (endpoint: string, diagnostics: Diagnostic[]) => Promise<Recorder> | Recorder
): Promise<Captured> {
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
    const endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const recorder = await run(endpoint, diagnostics);
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

const config = (endpoint: string, diagnostics: Diagnostic[]): RecorderConfig => ({
  endpoint,
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development",
  onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
});

type ConsumeOptions = Parameters<Recorder["consume"]>[0];

describe("consume", () => {
  it.each([
    ["undefined", (): unknown => undefined],
    ["null", (): unknown => null],
    ["a throwing context getter", (): unknown => throwingGetter({}, "context")],
    [
      "a context whose journeyId getter throws",
      (): unknown => ({ context: throwingGetter({ entity: { type: "t", id: "1" } }, "journeyId") })
    ],
    ["a Proxy", hostile]
  ])("does not throw given %s, and the journey records", async (_what, options) => {
    const { events, counters } = await withStub((endpoint, diagnostics) => {
      const recorder = createRecorder(config(endpoint, diagnostics));
      expect(() => {
        const journey = recorder.consume(options() as ConsumeOptions);
        journey.record({ operation: "consumed", name: "consume" });
      }).not.toThrow();
      return recorder;
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.["entity"]).toEqual({ type: "unknown", id: "unknown" });
    expect(counters.captureErrors).toBeGreaterThan(0);
  });

  it("still uses a readable context", async () => {
    const { events } = await withStub((endpoint, diagnostics) => {
      const recorder = createRecorder(config(endpoint, diagnostics));
      recorder
        .consume({ context: { journeyId: "jrn_given" }, entityFallback: { type: "t", id: "1" } })
        .record({ operation: "consumed", name: "consume" });
      return recorder;
    });
    expect(events[0]?.["journeyId"]).toBe("jrn_given");
    expect(events[0]?.["entity"]).toEqual({ type: "t", id: "1" });
  });
});

describe("the other entry points given nothing usable", () => {
  it("continueJourney, across and journeyIdFor do not throw", async () => {
    const { counters } = await withStub((endpoint, diagnostics) => {
      const recorder = createRecorder(config(endpoint, diagnostics));
      expect(() => {
        const lost = recorder.continueJourney(
          undefined as unknown as { journeyId: string; entity: { type: string; id: string } }
        );
        lost.record({ operation: "received", name: "r" });
        lost.label("a label");
        lost.identify({ a: "b" });
        lost.transform("t", 1, () => 2);
        recorder.continueJourney(hostile() as never).record({ operation: "received", name: "r" });
      }).not.toThrow();

      const throwingIterable = {
        [Symbol.iterator]: (): Iterator<never> => {
          throw new Error("iterator");
        }
      };
      expect(() => {
        recorder.across(undefined as never).record({ operation: "persisted", name: "w" });
        recorder.across(throwingIterable).record({ operation: "persisted", name: "w" });
        recorder.across([hostile() as never, null as never]).finish();
      }).not.toThrow();

      for (const entity of [undefined, null, hostile(), throwingGetter({ type: "t" }, "id")]) {
        let id = "";
        expect(() => {
          id = recorder.journeyIdFor(entity as never);
        }).not.toThrow();
        expect(id).toMatch(/^jrn_/);
      }
      return recorder;
    });
    // A journey with no usable context records nothing; what it lost is counted.
    expect(counters.captureErrors).toBeGreaterThan(0);
  });
});

describe("wrapper options", () => {
  it.each([
    ["null", (): unknown => null],
    ["a Proxy", hostile],
    ["a throwing attempt getter", (): unknown => throwingGetter({}, "attempt")],
    ["a throwing captureInput getter", (): unknown => throwingGetter({}, "captureInput")],
    [
      "metadata whose getter throws when copied",
      (): unknown => ({ metadata: throwingGetter({}, "tenant") })
    ],
    ["an attempt whose valueOf throws", (): unknown => ({ attempt: hostile() })]
  ])("given %s, run the callback once, return its value, and record", async (_what, options) => {
    let calls = 0;
    let returned: unknown;
    const { events } = await withStub((endpoint, diagnostics) => {
      const recorder = createRecorder(config(endpoint, diagnostics));
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      expect(() => {
        returned = journey.transform(
          "map",
          { a: 1 },
          () => {
            calls += 1;
            return "value";
          },
          options() as WrapOptions<string>
        );
      }).not.toThrow();
      return recorder;
    });
    expect(calls).toBe(1);
    expect(returned).toBe("value");
    expect(events).toHaveLength(1);
    expect(events[0]?.["operation"]).toBe("transformed");
    expect(events[0]?.["output"]).toBe("value");
  });

  it("still honours readable options", async () => {
    const { events } = await withStub((endpoint, diagnostics) => {
      const recorder = createRecorder(config(endpoint, diagnostics));
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      journey.deliver("send", { a: 1 }, () => ({ status: 422 }), {
        attempt: 2,
        metadata: { tenant: "acme" },
        captureInput: () => "projected",
        captureOutput: (result) => result.status,
        isFailure: (result) => result.status >= 400
      });
      return recorder;
    });
    expect(events[0]).toMatchObject({
      operation: "retried",
      input: "projected",
      output: 422,
      metadata: { tenant: "acme", attempt: 2 },
      error: { code: "result_failed" }
    });
  });
});

describe("createRecorder", () => {
  it.each([
    ["undefined", (): unknown => undefined],
    ["null", (): unknown => null],
    ["a Proxy", hostile]
  ])("starts given %s, and reports it", (_what, given) => {
    let recorder: Recorder | undefined;
    expect(() => {
      recorder = createRecorder(given() as RecorderConfig);
      recorder.startJourney({ entity: { type: "t", id: "1" } }).record({
        operation: "received",
        name: "r"
      });
    }).not.toThrow();
    expect(recorder?.diagnostics().configurationErrors).toBeGreaterThan(0);
    void recorder?.shutdown({ timeoutMs: 100 });
  });

  it("starts with an endpoint that is not a string, reports it, and returns from shutdown", async () => {
    const diagnostics: Diagnostic[] = [];
    let recorder: Recorder | undefined;
    expect(() => {
      recorder = createRecorder({
        ...config("unused", diagnostics),
        endpoint: undefined as unknown as string
      });
    }).not.toThrow();
    recorder?.startJourney({ entity: { type: "t", id: "1" } }).record({
      operation: "received",
      name: "r"
    });
    const counters = await recorder?.shutdown({ timeoutMs: 500 });
    expect(counters?.configurationErrors).toBe(1);
    expect(diagnostics.find((d) => d.kind === "configuration_error")?.reason).toContain("endpoint");
    // Nothing was delivered, and the event is counted, not lost silently.
    expect((counters?.sent ?? 0) + (counters?.dropped ?? 0)).toBe(1);
  });

  it("starts when a setting's getter throws, and records with the rest", async () => {
    const { events, counters, diagnostics } = await withStub((endpoint, seen) => {
      const recorder = createRecorder(throwingGetter(config(endpoint, seen), "redact"));
      recorder
        .startJourney({ entity: { type: "t", id: "1" } })
        .record({ operation: "received", name: "r", input: { password: "p" } });
      return recorder;
    });
    expect(counters.configurationErrors).toBe(1);
    expect(diagnostics.map((d) => d.reason)).toContain("redact could not be read.");
    expect(events).toHaveLength(1);
    // The built-in secret names still apply when the configured ones cannot be read.
    expect(events[0]?.["input"]).toEqual({ password: "[REDACTED]" });
  });
});
