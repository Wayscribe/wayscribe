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
  it("returns the callback's value unchanged", async () => {
    const value = { id: 7, nested: { ok: true } };
    await expect(journeyFor().transform("t", {}, () => value)).resolves.toBe(value);
  });

  it("awaits an async callback and returns its value", async () => {
    await expect(journeyFor().persist("p", {}, () => Promise.resolve("stored"))).resolves.toBe(
      "stored"
    );
  });

  it("rethrows the callback's exact error object", async () => {
    const thrown = new DomainError("phone_required");
    // Identity, not shape: application code branches on instanceof and on custom
    // properties, and a wrapped error would break handling that worked before
    // instrumentation was added.
    await expect(
      journeyFor().deliver("d", {}, () => {
        throw thrown;
      })
    ).rejects.toBe(thrown);
  });

  it("preserves a rejected promise's error object", async () => {
    const thrown = new DomainError("x");
    await expect(journeyFor().publish("pub", {}, () => Promise.reject(thrown))).rejects.toBe(
      thrown
    );
  });

  it("returns the value untouched even when isFailure marks it failed", async () => {
    const response = { status: 422 };
    const returned = await journeyFor().deliver("d", {}, () => response, {
      isFailure: (r) => (r as { status: number }).status >= 400
    });
    // isFailure changes what is recorded, never what the application receives.
    expect(returned).toBe(response);
  });

  it("survives an isFailure predicate that throws", async () => {
    await expect(
      journeyFor().deliver("d", {}, () => "value", {
        isFailure: () => {
          throw new Error("predicate exploded");
        }
      })
    ).resolves.toBe("value");
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
    const events = await recordAnd(async (journey) => {
      await journey
        .persist("p", {}, () => {
          throw new DomainError("phone_required");
        })
        .catch(() => undefined);
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
