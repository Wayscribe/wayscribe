import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecorder, type Journey } from "./recorder.js";

// Port 1 refuses connections: the contract assertions below all hold with a dead
// transport, which is the point.
const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

class DomainError extends Error {
  public constructor(public readonly code: string) {
    super("domain failure");
  }
}

function journeyFor(): Journey {
  return createRecorder(base).startJourney({ entity: { type: "customer", id: "1" } });
}

describe("wrapper contract", () => {
  it("returns a synchronous callback's value synchronously", () => {
    // Not `await` and not `.resolves`: a sync callback must produce a value,
    // not a promise. This test asserted the opposite until the wrappers stopped
    // being unconditionally async — it was encoding the defect.
    const value = { id: 7, nested: { ok: true } };
    expect(journeyFor().transform("t", {}, () => value)).toBe(value);
  });

  it("awaits an async callback and returns its value", async () => {
    await expect(journeyFor().persist("p", {}, () => Promise.resolve("stored"))).resolves.toBe(
      "stored"
    );
  });

  it("rethrows a synchronous callback's exact error synchronously", () => {
    const thrown = new DomainError("phone_required");
    // Identity, not shape: application code branches on instanceof and on
    // custom properties, and a wrapped error would break handling that worked
    // before instrumentation was added.
    //
    // Synchronously, because that is what the caller's try/catch is waiting
    // for. Named "rethrows the exact error" while asserting `.rejects`, this
    // test used to document the bug: a handler that correctly returned 400 on
    // malformed input became a 200 with an empty body the moment a transform
    // was wrapped around its JSON.parse.
    expect(() =>
      journeyFor().deliver("d", {}, () => {
        throw thrown;
      })
    ).toThrow(thrown);
  });

  it("still rejects for an async callback", () => {
    // The other half of the contract, so the shape genuinely follows the
    // callback rather than always being one or the other.
    const thrown = new DomainError("async");
    return expect(journeyFor().deliver("d", {}, () => Promise.reject(thrown))).rejects.toBe(thrown);
  });

  it("preserves a rejected promise's error object", async () => {
    const thrown = new DomainError("x");
    await expect(journeyFor().publish("pub", {}, () => Promise.reject(thrown))).rejects.toBe(
      thrown
    );
  });

  it("returns the value untouched even when isFailure marks it failed", () => {
    const response = { status: 422 };
    const returned = journeyFor().deliver("d", {}, () => response, {
      isFailure: (r) => (r as { status: number }).status >= 400
    });
    // isFailure changes what is recorded, never what the application receives.
    expect(returned).toBe(response);
  });

  it("survives an isFailure predicate that throws", () => {
    // Sync callback, so a sync return: the recorder's own failure must not
    // reach the caller either way.
    expect(
      journeyFor().deliver("d", {}, () => "value", {
        isFailure: () => {
          throw new Error("predicate exploded");
        }
      })
    ).toBe("value");
  });

  it("fail and finish do not throw", () => {
    const journey = journeyFor();
    expect(() => {
      journey.fail("f", new Error("boom"), { attempt: 3 });
      journey.finish({ status: "failed" });
    }).not.toThrow();
  });

  it("consume builds a journey from a supplied context", () => {
    const journey = createRecorder(base).consume({
      context: { journeyId: "jrn_existing", entity: { type: "customer", id: "9" } }
    });
    expect(journey.context().journeyId).toBe("jrn_existing");
  });

  it("consume falls back to an entity when no context was propagated", () => {
    const journey = createRecorder(base).consume({
      entityFallback: { type: "customer", id: "9" }
    });
    expect(journey.context().journeyId).toMatch(/^jrn_/);
    expect(journey.context().entity.id).toBe("9");
  });
});

describe("recorded events", () => {
  let server: Server;
  let endpoint: string;
  let received: Record<string, unknown>[];

  beforeEach(async () => {
    received = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
        received.push(...parsed.events.map((entry) => entry.event));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { results: [] } }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  // `unknown` rather than `Promise<unknown> | void`: awaiting a non-promise is a
  // no-op, and void in a union is not a valid constituent.
  async function recordAnd(fn: (journey: Journey) => unknown): Promise<Record<string, unknown>[]> {
    const recorder = createRecorder({ ...base, endpoint });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    await fn(journey);
    await recorder.shutdown({ timeoutMs: 2_000 });
    return received;
  }

  it("records the natural operation and a duration", async () => {
    const events = await recordAnd((journey) => journey.transform("t", { a: 1 }, () => ({ a: 2 })));
    const transformed = events.find((e) => e["operation"] === "transformed");
    expect(transformed).toBeDefined();
    expect(transformed?.["durationMs"]).toBeTypeOf("number");
  });

  it("records retried when the attempt is greater than one", async () => {
    // ADR-022: the caller supplies attempt, because a retry commonly happens in
    // a different process consuming a redelivered message.
    const events = await recordAnd((journey) =>
      journey.deliver("d", {}, () => "ok", { attempt: 2 })
    );
    expect(events.some((e) => e["operation"] === "retried")).toBe(true);
    expect(events.some((e) => e["operation"] === "delivered")).toBe(false);
  });

  it("records an error for a non-throwing failure", async () => {
    const events = await recordAnd((journey) =>
      journey.deliver("d", {}, () => ({ status: 422 }), {
        isFailure: (r) => (r as { status: number }).status >= 400
      })
    );
    expect(events.find((e) => e["operation"] === "delivered")?.["error"]).toBeDefined();
  });

  it("records the thrown error's message, type, and code", async () => {
    const events = await recordAnd((journey) => {
      // Synchronous throw, so a synchronous catch.
      try {
        journey.persist("p", {}, (): string => {
          throw new DomainError("phone_required");
        });
      } catch {
        // Expected: the wrapper rethrows the caller's own error.
      }
    });
    expect(events.find((e) => e["operation"] === "persisted")?.["error"]).toMatchObject({
      type: "Error",
      code: "phone_required"
    });
  });

  it("records finish as completed", async () => {
    const events = await recordAnd((journey) => {
      journey.finish({ status: "completed" });
    });
    expect(events.some((e) => e["operation"] === "completed")).toBe(true);
  });

  it("records the input and output it was given", async () => {
    const events = await recordAnd((journey) =>
      journey.transform("t", { Phone: "+1 919 555 1234" }, () => ({ phone: null }))
    );
    const transformed = events.find((e) => e["operation"] === "transformed");
    expect(transformed?.["input"]).toEqual({ Phone: "+1 919 555 1234" });
    expect(transformed?.["output"]).toEqual({ phone: null });
  });

  it("puts aliases where the protocol reads them", async () => {
    // EVENT_PROTOCOL: aliases are a top-level field on the event. Nesting them
    // under metadata is silently accepted by ingestion and then ignored, which
    // costs the journey every alias-based search.
    const events = await recordAnd((journey) => {
      journey.identify({ internalCustomerId: "18492" });
    });
    const identified = events.find((e) => e["operation"] === "identified");
    expect(identified?.["aliases"]).toEqual({ internalCustomerId: "18492" });
  });

  it("timestamps a wrapped operation when it started, not when it finished", async () => {
    // Cross-service ordering is by timestamp. Stamping at completion inverts
    // causality whenever the work a step triggers finishes faster than the step
    // itself: a publish that takes 50ms sorts after the consume it caused.
    const startedAt = Date.now();
    const events = await recordAnd((journey) =>
      journey.publish("p", {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      })
    );

    const published = events.find((e) => e["operation"] === "published");
    const stamped = new Date(String(published?.["timestamp"])).getTime();
    expect(stamped).toBeGreaterThanOrEqual(startedAt);
    expect(stamped).toBeLessThan(startedAt + 50);
  });
});

describe("the server's verdict", () => {
  /**
   * The batch route replies 202 even when it stored nothing, so these assert on
   * what the SDK does with the body. Before it read the body, an environment
   * typo produced counters identical to a healthy run.
   */
  async function serverReplying(
    results: unknown[]
  ): Promise<{ endpoint: string; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { results } }));
      });
    });
    // listen is asynchronous; address() is null until it fires.
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${String(port)}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        })
    };
  }

  it("does not count a refused event as sent", async () => {
    const server = await serverReplying([
      {
        status: "rejected",
        error: { code: "unauthorized_environment", message: "no", httpStatus: 403 }
      }
    ]);
    const recorder = createRecorder({ ...base, endpoint: server.endpoint });
    recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
      operation: "received",
      name: "n"
    });

    const counters = await recorder.shutdown({ timeoutMs: 2_000 });
    expect(counters.sent).toBe(0);
    expect(counters.rejected).toBe(1);
    await server.close();
  });

  it("reports the server's own reason, not a generic one", async () => {
    const seen: string[] = [];
    const server = await serverReplying([
      {
        status: "rejected",
        error: {
          code: "invalid_event",
          message: "The event failed validation.",
          httpStatus: 400,
          details: [{ path: "event.entity.id", message: "expected string, received number" }]
        }
      }
    ]);
    const recorder = createRecorder({
      ...base,
      endpoint: server.endpoint,
      onDiagnostic: (d) => seen.push(`${d.kind}|${d.reason}`)
    });
    recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
      operation: "received",
      name: "n"
    });
    await recorder.shutdown({ timeoutMs: 2_000 });

    // The specific field is what ends the investigation. "invalid_event" alone
    // starts one.
    expect(seen.join()).toContain("rejected|");
    expect(seen.join()).toContain("event.entity.id");
    expect(seen.join()).toContain("expected string, received number");
    await server.close();
  });

  it("counts a mixed batch honestly", async () => {
    const server = await serverReplying([
      { status: "accepted", eventId: "evt_1" },
      { status: "rejected", error: { code: "invalid_event", message: "no", httpStatus: 400 } },
      { status: "accepted", eventId: "evt_3" }
    ]);
    const recorder = createRecorder({ ...base, endpoint: server.endpoint, batchSize: 3 });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    for (let i = 0; i < 3; i += 1) journey.record({ operation: "received", name: `n${String(i)}` });

    const counters = await recorder.shutdown({ timeoutMs: 2_000 });
    expect(counters.sent).toBe(2);
    expect(counters.rejected).toBe(1);
    await server.close();
  });

  it("still counts a fully accepted batch as sent", async () => {
    // The control. Without it, a change that reported zero for everything would
    // pass all three tests above.
    const server = await serverReplying([{ status: "accepted", eventId: "evt_1" }]);
    const recorder = createRecorder({ ...base, endpoint: server.endpoint });
    recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
      operation: "received",
      name: "n"
    });

    const counters = await recorder.shutdown({ timeoutMs: 2_000 });
    expect(counters.sent).toBe(1);
    expect(counters.rejected).toBe(0);
    await server.close();
  });
});

describe("payloads the application cannot serialize", () => {
  /** Its own collector: `recordAnd` above is scoped to another block. */
  async function collect(use: (journey: Journey) => unknown): Promise<Record<string, unknown>[]> {
    const received: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
        received.push(...parsed.events.map((entry) => entry.event));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: { results: parsed.events.map(() => ({ status: "accepted" })) }
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;

    const recorder = createRecorder({ ...base, endpoint: `http://127.0.0.1:${String(port)}` });
    await use(recorder.startJourney({ entity: { type: "customer", id: "1" } }));
    await recorder.shutdown({ timeoutMs: 2_000 });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return received;
  }

  it("keeps the event when a getter throws", async () => {
    // Verified failing before the guard: the throw escaped from inside the
    // event literal, before queue.push, so the event vanished with dropped: 0.
    const order = {
      id: "ord_1",
      lines: undefined as unknown[] | undefined,
      get total(): number {
        // Throws because `lines` is undefined — the shape a real object has
        // when an upstream mapping did not populate a relation.
        return (this.lines as unknown[]).length;
      }
    };

    const events = await collect((journey) => {
      journey.record({ operation: "received", name: "receive-order", input: order });
    });

    const received = events.find((e) => e["name"] === "receive-order");
    expect(received).toBeDefined();
    expect(received?.["input"]).toBe("[UNCAPTURABLE]");
  });

  it("keeps the event, and its error, when the failing step is the one recorded", async () => {
    // The case that matters most: the payload that cannot be captured belongs
    // to the step that just failed. Losing it loses the failure.
    const hostile = {
      get boom(): never {
        throw new Error("getter exploded");
      }
    };

    const events = await collect((journey) => {
      try {
        journey.persist("save", hostile, (): string => {
          throw new Error("insert failed");
        });
      } catch {
        // Expected.
      }
    });

    const persisted = events.find((e) => e["operation"] === "persisted");
    expect(persisted?.["input"]).toBe("[UNCAPTURABLE]");
    expect((persisted?.["error"] as { message: string }).message).toBe("insert failed");
  });

  it("stores an ORM row that points back at its parent", async () => {
    // Found by instrumenting a real application rather than by a unit test: a
    // parent/child graph is what every ORM hands back, and the whole payload
    // was dropped as `payload_too_large`. `redact` cuts the loop to a marker
    // and keeps the rest — the byte check simply ran first and never let it.
    const run: Record<string, unknown> = { id: "run_1", status: "completed" };
    const child: Record<string, unknown> = { label: "step one", parent: run };
    run["steps"] = [child];

    const events = await collect((journey) => {
      journey.record({ operation: "received", name: "load-run", input: run });
    });

    const input = events.find((e) => e["name"] === "load-run")?.["input"] as
      Record<string, unknown> | undefined;
    expect(input?.["status"]).toBe("completed");
    expect((input?.["steps"] as Record<string, unknown>[])[0]?.["label"]).toBe("step one");
    expect((input?.["steps"] as Record<string, unknown>[])[0]?.["parent"]).toBe("[CIRCULAR]");
  });

  it("stores a bigint id as digits rather than dropping the payload", async () => {
    // A Postgres `bigint` column and a snowflake id are both routine. The
    // diagnostic said `payload_too_large`, which sends an operator to raise
    // maxPayloadBytes — a setting that could never have helped.
    const events = await collect((journey) => {
      journey.record({
        operation: "received",
        name: "load-row",
        input: { id: 9_007_199_254_740_993n, name: "Dana" }
      });
    });

    const input = events.find((e) => e["name"] === "load-row")?.["input"] as
      Record<string, unknown> | undefined;
    // The digits BigInt exists to preserve: a Number would render ...992.
    expect(input?.["id"]).toBe("9007199254740993");
    expect(input?.["name"]).toBe("Dana");
  });

  it("still refuses a payload that is genuinely too large", async () => {
    // The control for both tests above. Tolerating cycles and bigints must not
    // turn the size guard off.
    const events = await collect((journey) => {
      journey.record({
        operation: "received",
        name: "load-blob",
        input: { blob: "x".repeat(400_000) }
      });
    });

    expect(events.find((e) => e["name"] === "load-blob")?.["input"]).toBe("[PAYLOAD_TOO_LARGE]");
  });
});

describe("burst behaviour", () => {
  /** Counts concurrent requests, so fan-out is measured rather than assumed. */
  async function burst(
    count: number
  ): Promise<{ peak: number; requests: number; received: number }> {
    let inFlight = 0;
    let peak = 0;
    let requests = 0;
    let received = 0;

    const server = createServer((request, response) => {
      inFlight += 1;
      requests += 1;
      peak = Math.max(peak, inFlight);
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { events: unknown[] };
        received += parsed.events.length;
        // A real send takes time; resolving instantly would hide the fan-out.
        setTimeout(() => {
          inFlight -= 1;
          response.writeHead(202, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data: { results: parsed.events.map(() => ({ status: "accepted" })) }
            })
          );
        }, 15);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;

    const recorder = createRecorder({
      ...base,
      endpoint: `http://127.0.0.1:${String(port)}`,
      batchSize: 10
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    for (let i = 0; i < count; i += 1) {
      journey.record({ operation: "received", name: `n${String(i)}` });
    }
    await recorder.shutdown({ timeoutMs: 10_000 });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return { peak, requests, received };
  }

  it("bounds concurrent requests during a burst", async () => {
    // 400 events at batchSize 10 used to open 40 sockets at once. The queue is
    // bounded and the interval drains the remainder, so capping costs nothing
    // but a little latency.
    const { peak } = await burst(400);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("still delivers every event", async () => {
    // The control. A cap that simply dropped work would pass the test above.
    const { received } = await burst(120);
    expect(received).toBe(120);
  });
});

describe("after shutdown", () => {
  it("says so instead of silently discarding", async () => {
    // shutdown() was a permanent kill switch with no signal: wrappers kept
    // returning the right value while nothing reached the server.
    const seen: string[] = [];
    const recorder = createRecorder({
      ...base,
      onDiagnostic: (d) => seen.push(`${d.kind}|${d.reason}`)
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    const counters = await recorder.shutdown({ timeoutMs: 500 });
    expect(counters.dropped).toBe(0);

    journey.record({ operation: "received", name: "too-late" });

    expect(seen.some((line) => line.startsWith("dropped|"))).toBe(true);
    expect(seen.join()).toContain("shut down");
    expect(recorder.diagnostics().dropped).toBe(1);
  });
});

describe("instrumenting a synchronous handler", () => {
  /**
   * The failure the audit found, reduced to its essentials: a handler that
   * correctly returns 400 on malformed input, with one wrapper added around its
   * JSON.parse. Before the wrappers preserved shape, the throw became a
   * rejected promise nobody awaited — the handler returned 200 with an empty
   * body and the process took an unhandled rejection, from one bad request.
   */
  function handle(raw: string): { status: number; body: unknown } {
    const journey = createRecorder({
      endpoint: "http://127.0.0.1:1",
      apiKey: "fr_test",
      serviceName: "api",
      environment: "development"
    }).startJourney({ entity: { type: "customer", id: "1" } });

    try {
      const parsed = journey.transform("parse-body", raw, () => JSON.parse(raw) as unknown);
      return { status: 200, body: parsed };
    } catch {
      return { status: 400, body: { error: "malformed json" } };
    }
  }

  it("leaves the caller's try/catch working", () => {
    expect(handle("{not json")).toEqual({ status: 400, body: { error: "malformed json" } });
  });

  it("still returns the parsed value on the happy path", () => {
    // The control: a wrapper that always threw would pass the test above.
    expect(handle('{"ok":true}')).toEqual({ status: 200, body: { ok: true } });
  });

  it("produces a value, not a promise", () => {
    const journey = createRecorder({
      endpoint: "http://127.0.0.1:1",
      apiKey: "fr_test",
      serviceName: "api",
      environment: "development"
    }).startJourney({ entity: { type: "customer", id: "1" } });

    const result = journey.transform("double", 2, () => 4);
    expect(result).toBe(4);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
  });
});
