import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Counters, Diagnostic } from "./diagnostics.js";
import { createRecorder, type Recorder } from "./index.js";

/**
 * The failure boundary must hold for any value a host can throw, including
 * ones that cannot be inspected: describing a thrown value used to be able to
 * throw a second time, from inside the boundary, into the host (ADR-007).
 */

/** `String()` of it throws: there is no toString to call. */
const nullPrototype = (): unknown => Object.create(null) as unknown;

/** `instanceof` and `String()` of it both throw. */
const revokedProxy = (): unknown => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};

const hostileValues: [string, () => unknown][] = [
  ["a null-prototype object", nullPrototype],
  ["a revoked Proxy", revokedProxy]
];

const throwing = (value: unknown): object =>
  new Proxy(
    {},
    {
      get: () => {
        throw value;
      }
    }
  );

async function capture(run: (recorder: Recorder) => Promise<void> | void): Promise<{
  events: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  counters: Counters;
}> {
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
  const recorder = createRecorder({
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development",
    onDiagnostic: (d) => diagnostics.push(d)
  });
  try {
    await run(recorder);
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

describe.each(hostileValues)("a thrown %s", (_what, make) => {
  it("does not escape continueJourney, startJourney, across or the wrapper options", async () => {
    const { events, counters, diagnostics } = await capture((recorder) => {
      expect(() => {
        recorder.continueJourney(throwing(make())).record({ operation: "consumed", name: "a" });
        recorder
          .continueJourney({
            get context(): never {
              throw make();
            },
            entity: { type: "t", id: "1" }
          })
          .record({ operation: "consumed", name: "b" });
        recorder
          .startJourney(throwing(make()) as never)
          .record({ operation: "received", name: "c" });
        const iterable = {
          [Symbol.iterator]: (): never => {
            throw make();
          }
        };
        recorder.across(iterable).record({ operation: "persisted", name: "never" });
        const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
        expect(journey.transform("d", 1, () => 2, throwing(make()) as never)).toBe(2);
      }).not.toThrow();
    });
    expect(events.map((event) => event["name"]).sort()).toEqual(["a", "b", "c", "d"]);
    expect(counters.captureErrors).toBeGreaterThan(0);
    // Described by a fixed sentence, since the value itself cannot be.
    expect(
      diagnostics.some(
        (d) =>
          d.code === "unexpected_error" &&
          d.reason === "A value was thrown that cannot be described."
      )
    ).toBe(true);
  });

  it("is rethrown by a wrapper as it was, and the failure is recorded", async () => {
    const value = make();
    let caught: unknown;
    const { events } = await capture(async (recorder) => {
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      try {
        journey.transform("sync", 1, (): number => {
          throw value;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(value);
      await expect(journey.persist("async", 1, () => Promise.reject(value as Error))).rejects.toBe(
        value
      );
      journey.fail("dead-letter", value);
    });
    expect(events.map((event) => event["name"])).toEqual(["sync", "async", "dead-letter"]);
    for (const event of events) {
      expect(event["error"]).toEqual({ message: "The thrown value could not be read." });
    }
  });
});

describe("a callback's value whose then cannot be read", () => {
  it("rejects with the getter's error, records the step as failed, and reports it", async () => {
    const problem = new Error("then getter");
    const value = {
      get then(): never {
        throw problem;
      }
    };
    let returned: unknown;
    const { events, diagnostics } = await capture(async (recorder) => {
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      expect(() => {
        returned = journey.deliver("send", 1, () => value);
      }).not.toThrow();
      expect(returned).toBeInstanceOf(Promise);
      await expect(returned).rejects.toBe(problem);
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "delivered",
      error: { message: "then getter", type: "Error" }
    });
    expect(diagnostics.filter((d) => d.kind === "capture_error").map((d) => d.code)).toEqual([
      "unexpected_error"
    ]);
  });
});
