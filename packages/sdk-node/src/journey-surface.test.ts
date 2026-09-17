import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { journeyEventSchema } from "@wayscribe/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import {
  createRecorder,
  type ContinueJourneyOptions,
  type Entity,
  type ErrorInput,
  type FailOptions,
  type FinishOptions,
  type IdentifyOptions,
  type Journey,
  type PropagatedContext,
  type RecordInput,
  type Recorder,
  type RecorderConfig,
  type ShutdownOptions,
  type StartJourneyOptions,
  type WrapOptions
} from "./index.js";
// @ts-expect-error TraceContext is not part of the public surface (M11).
import type { TraceContext } from "./index.js";

/**
 * The journey half of the public surface as the API review left it: one
 * `continueJourney` for every way of joining a journey, an options object on
 * `fail`, one name for the displayable list, and wrapper types that match what
 * the wrappers do at runtime.
 */

const base = {
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

async function capture(
  run: (recorder: Recorder) => Promise<void> | void,
  extra: Partial<RecorderConfig> = {}
): Promise<{ events: Record<string, unknown>[]; diagnostics: Diagnostic[] }> {
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
    ...base,
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    onDiagnostic: (d) => diagnostics.push(d),
    ...extra
  });
  try {
    await run(recorder);
    await recorder.shutdown({ timeoutMs: 5_000 });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  return { events, diagnostics };
}

const offline = (): Recorder => createRecorder({ ...base, endpoint: "http://127.0.0.1:1" });

describe("continueJourney", () => {
  it("joins a propagated journey, with the context's entity over the fallback", () => {
    const recorder = offline();
    const journey = recorder.continueJourney({
      context: { journeyId: "jrn_given", entity: { type: "order", id: "7" } },
      entity: { type: "customer", id: "42" }
    });
    expect(journey.context()).toEqual({
      journeyId: "jrn_given",
      entity: { type: "order", id: "7" }
    });
  });

  it("uses the fallback entity when the context carries none, as it does by default", () => {
    const journey = offline().continueJourney({
      context: { journeyId: "jrn_given" },
      entity: { type: "customer", id: "42" }
    });
    expect(journey.context()).toEqual({
      journeyId: "jrn_given",
      entity: { type: "customer", id: "42" }
    });
  });

  it("starts a new journey when nothing was propagated", () => {
    const recorder = offline();
    const first = recorder.continueJourney({
      context: undefined,
      entity: { type: "customer", id: "42" }
    });
    const second = recorder.continueJourney({ entity: { type: "customer", id: "42" } });
    expect(first.context().journeyId).toMatch(/^jrn_/);
    expect(first.context().journeyId).not.toBe(second.context().journeyId);
    expect(first.context().entity).toEqual({ type: "customer", id: "42" });
  });

  it("continues a journey by id, which is the same object a context is", () => {
    const recorder = offline();
    const entity = { type: "job_posting", id: "p1" };
    const started = recorder.startJourney({ entity });
    expect(recorder.continueJourney({ journeyId: "jrn_known", entity }).context()).toEqual({
      journeyId: "jrn_known",
      entity
    });
    expect(recorder.continueJourney(started.context()).context()).toEqual(started.context());
  });

  it("prefers the propagated context's id to a journeyId", () => {
    const journey = offline().continueJourney({
      context: { journeyId: "jrn_propagated" },
      journeyId: "jrn_local",
      entity: { type: "t", id: "1" }
    });
    expect(journey.context().journeyId).toBe("jrn_propagated");
  });

  it.each([
    ["an empty string", ""],
    ["a number", 42],
    ["null", null]
  ])("reports a journeyId that is %s and starts a new journey", async (_what, journeyId) => {
    let id = "";
    const { events, diagnostics } = await capture((recorder) => {
      const journey = recorder.continueJourney({
        journeyId: journeyId as unknown as string,
        entity: { type: "t", id: "1" }
      });
      id = journey.context().journeyId;
      journey.record({ operation: "received", name: "r" });
    });
    expect(id).toMatch(/^jrn_[0-9a-f-]{36}$/);
    expect(events[0]?.["journeyId"]).toBe(id);
    expect(diagnostics.filter((d) => d.kind === "configuration_error")).toMatchObject([
      { code: "journey_id_invalid", detail: {} }
    ]);
  });

  it("sets the label before anything is recorded", async () => {
    const { events } = await capture((recorder) => {
      recorder
        .continueJourney({
          context: { journeyId: "jrn_given" },
          entity: { type: "t", id: "1" },
          label: "Acme · Engineer"
        })
        .record({ operation: "consumed", name: "consume" });
    });
    expect(events[0]?.["journeyLabel"]).toBe("Acme · Engineer");
  });

  it("replaces consume, which recorded nothing despite its name", () => {
    expect("consume" in offline()).toBe(false);
  });

  it("accepts an explicit undefined for every option", () => {
    const options: ContinueJourneyOptions = {
      context: undefined,
      journeyId: undefined,
      entity: undefined,
      label: undefined
    };
    expect(offline().continueJourney(options).context().entity).toEqual({
      type: "unknown",
      id: "unknown"
    });
  });
});

/** What the server would say about the event, by its own schema. */
const valid = (event: Record<string, unknown> | undefined): boolean =>
  journeyEventSchema.safeParse(event).success;

/** Every report but the one good-news diagnostic, as `kind/code`. */
const reported = (diagnostics: Diagnostic[]): string[] =>
  diagnostics.filter((d) => d.kind !== "delivered_first").map((d) => `${d.kind}/${d.code}`);

describe("continueJourney given a context it cannot use", () => {
  const handle = offline().startJourney({ entity: { type: "t", id: "1" } });
  it.each([
    ["an empty object", {}, undefined],
    ["a string", "jrn_x", undefined],
    ["a journey handle rather than its context", handle, undefined],
    ["a numeric journey id", { journeyId: 42 }, undefined],
    ["an empty journey id", { journeyId: "" }, undefined],
    ["an empty object beside a held id", {}, "jrn_held"]
  ])("treats %s as absent, reports it, and records a valid event", async (_what, context, held) => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .continueJourney({
          context: context as unknown as PropagatedContext,
          ...(held === undefined ? {} : { journeyId: held }),
          entity: { type: "customer", id: "42" }
        })
        .record({ operation: "consumed", name: "consume" });
    });
    expect(events).toHaveLength(1);
    expect(valid(events[0])).toBe(true);
    if (held === undefined) {
      expect(events[0]?.["journeyId"]).toMatch(/^jrn_[0-9a-f-]{36}$/);
    } else {
      expect(events[0]?.["journeyId"]).toBe(held);
    }
    expect(events[0]?.["entity"]).toEqual({ type: "customer", id: "42" });
    expect(diagnostics.filter((d) => d.kind === "configuration_error")).toEqual([
      expect.objectContaining({ code: "journey_id_invalid", detail: { setting: "context" } })
    ]);
  });

  it("keeps a usable id from a context whose entity is malformed, and uses the fallback entity", async () => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .continueJourney({
          context: { journeyId: "jrn_context", entity: { type: "order" } as unknown as Entity },
          entity: { type: "customer", id: "42" }
        })
        .record({ operation: "consumed", name: "consume" });
    });
    expect(events[0]).toMatchObject({
      journeyId: "jrn_context",
      entity: { type: "customer", id: "42" }
    });
    expect(reported(diagnostics)).toEqual(["configuration_error/entity_invalid"]);
    expect(diagnostics[0]?.detail).toEqual({ setting: "context" });
  });

  it("reports nothing for a usable context", async () => {
    const { diagnostics } = await capture((recorder) => {
      recorder
        .continueJourney({ context: handle.context() })
        .record({ operation: "consumed", name: "consume" });
    });
    expect(reported(diagnostics)).toEqual([]);
  });
});

describe("an entity the recorder cannot record", () => {
  const unusable: [string, unknown][] = [
    ["null", null],
    ["a string", "customer-1"],
    ["an empty type", { type: "", id: "1" }],
    ["an empty id", { type: "customer", id: "" }],
    ["a numeric id", { type: "customer", id: 1 }],
    ["no id", { type: "customer" }]
  ];

  it.each(unusable)(
    "is reported by startJourney when it is %s, and the steps are recorded under the unknown entity",
    async (_what, entity) => {
      const { events, diagnostics } = await capture((recorder) => {
        recorder
          .startJourney({ entity: entity as Entity })
          .record({ operation: "received", name: "receive" });
      });
      expect(events).toHaveLength(1);
      expect(valid(events[0])).toBe(true);
      expect(events[0]?.["entity"]).toEqual({ type: "unknown", id: "unknown" });
      expect(reported(diagnostics)).toContain("configuration_error/entity_invalid");
      expect(diagnostics.find((d) => d.code === "entity_invalid")?.detail).toEqual({
        setting: "entity"
      });
    }
  );

  it.each(unusable)("is reported by continueJourney when it is %s", async (_what, entity) => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .continueJourney({ journeyId: "jrn_held", entity: entity as Entity })
        .record({ operation: "consumed", name: "consume" });
    });
    expect(events[0]).toMatchObject({
      journeyId: "jrn_held",
      entity: { type: "unknown", id: "unknown" }
    });
    expect(valid(events[0])).toBe(true);
    expect(reported(diagnostics)).toEqual(["configuration_error/entity_invalid"]);
  });

  it("is reported when neither the context nor the options carry one", async () => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .continueJourney({ context: { journeyId: "jrn_bare" } })
        .record({ operation: "consumed", name: "consume" });
    });
    expect(events[0]?.["entity"]).toEqual({ type: "unknown", id: "unknown" });
    expect(reported(diagnostics)).toEqual(["configuration_error/entity_invalid"]);
  });

  it("is copied, so a later change to the caller's object is not recorded", async () => {
    const entity = { type: "customer", id: "42" };
    const { events, diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity });
      entity.id = "changed";
      journey.record({ operation: "received", name: "receive" });
    });
    expect(events[0]?.["entity"]).toEqual({ type: "customer", id: "42" });
    expect(reported(diagnostics)).toEqual([]);
  });
});

describe("continueJourney given no options at all", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7]
  ])("reports %s once, and still records", async (_what, options) => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .continueJourney(options as unknown as ContinueJourneyOptions)
        .record({ operation: "consumed", name: "consume" });
    });
    expect(events).toHaveLength(1);
    expect(valid(events[0])).toBe(true);
    expect(reported(diagnostics)).toEqual(["capture_error/invalid_options"]);
    expect(diagnostics.find((d) => d.code === "invalid_options")?.detail).toEqual({
      call: "continueJourney"
    });
  });
});

describe("fail given options it cannot use", () => {
  it.each([
    ["positional metadata, as fail took before", { attempt: 3 }, undefined],
    ["a string", "dlq", undefined],
    ["null", null, undefined],
    ["an array", [1], undefined],
    ["metadata beside another key", { metadata: { queue: "dlq" }, attempt: 3 }, { queue: "dlq" }]
  ])("reports %s and still records the failure", async (_what, options, metadata) => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "t", id: "1" } })
        .fail("dead-letter", new Error("gave up"), options as unknown as FailOptions);
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.["metadata"]).toEqual(metadata);
    expect(reported(diagnostics)).toEqual(["capture_error/invalid_options"]);
    expect(diagnostics.find((d) => d.code === "invalid_options")?.detail).toEqual({
      call: "fail"
    });
    // The keys of a host's object can be data; they are never quoted.
    expect(JSON.stringify(diagnostics)).not.toContain("attempt");
  });

  it("reports nothing for { metadata } or no options", async () => {
    const { diagnostics } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      journey.fail("a", new Error("x"), { metadata: { queue: "dlq" } });
      journey.fail("b", new Error("x"));
      journey.fail("c", new Error("x"), {});
    });
    expect(reported(diagnostics)).toEqual([]);
  });
});

describe("fail", () => {
  it("takes its metadata in an options object", async () => {
    const { events } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "t", id: "1" } })
        .fail("dead-letter", new Error("gave up"), { metadata: { queue: "dlq" } });
    });
    expect(events[0]).toMatchObject({
      operation: "failed",
      name: "dead-letter",
      error: { message: "gave up", type: "Error" },
      metadata: { queue: "dlq" }
    });
  });

  it("does not throw given options it cannot read", async () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("hostile");
        }
      }
    );
    const { events } = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      expect(() => {
        journey.fail("f", new Error("boom"), hostile);
        journey.fail("g", new Error("boom"), null as unknown as FailOptions);
        journey.fail("h", new Error("boom"), { metadata: undefined });
      }).not.toThrow();
    });
    expect(events.map((event) => event["name"])).toEqual(["f", "g", "h"]);
    expect(events.every((event) => !("metadata" in event))).toBe(true);
  });
});

describe("displayableAliases", () => {
  it("is the one name, on identify, startJourney and record", async () => {
    const { events } = await capture((recorder) => {
      const journey = recorder.startJourney({
        entity: { type: "job_posting", id: "p1" },
        aliases: { postingId: "p1" },
        displayableAliases: ["postingId"]
      });
      journey.identify({ board: "acme" }, { displayableAliases: ["board"] });
      journey.record({
        operation: "identified",
        name: "identify",
        aliases: { company: "Acme" },
        displayableAliases: ["company"]
      });
    });
    expect(events.map((event) => event["displayableAliases"])).toEqual([
      ["postingId"],
      ["board"],
      ["company"]
    ]);
  });

  it("is no longer read under the old name", async () => {
    const { events, diagnostics } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "t", id: "1" } })
        .identify({ a: "b" }, { displayable: ["a"] } as unknown as IdentifyOptions);
      recorder.startJourney({
        entity: { type: "t", id: "2" },
        aliases: { a: "b" },
        displayable: ["a"]
      } as unknown as StartJourneyOptions);
    });
    expect(events).toHaveLength(2);
    expect(events[0]).not.toHaveProperty("displayableAliases");
    expect(events[1]).not.toHaveProperty("displayableAliases");
    // Reported, since a JavaScript caller would otherwise lose the list unseen.
    expect(
      diagnostics
        .filter((d) => d.code === "setting_renamed")
        .map((d) => [d.reason.includes("displayableAliases"), d.detail])
    ).toEqual([
      [true, { setting: "displayable" }],
      [true, { setting: "displayable" }]
    ]);
  });
});

describe("record's error", () => {
  it("takes a stack, masked and bounded like the message", async () => {
    // Assembled, so the source holds no string a secret scanner reads as a key.
    const token = "sk_" + "live_" + "SurfaceStackOpaque000001";
    const error: ErrorInput = {
      message: "charge failed",
      stack: `Error: charge failed for ${token}\n${"    at frame (/app/x.js:1:1)\n".repeat(1_000)}`
    };
    const { events } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "t", id: "1" } })
        .record({ operation: "failed", name: "charge", error });
    });
    const sent = events[0]?.["error"] as { stack: string };
    expect(sent.stack.length).toBeLessThanOrEqual(16_384);
    expect(sent.stack).not.toContain(token);
  });
});

describe("the wrappers and thenables", () => {
  /** A thenable that is not a native promise, as some query builders return. */
  const thenable = <T>(value: T): PromiseLike<T> => ({
    then: (resolve, reject) => {
      // A thenable again, not a promise, so a wrapper that returned whatever
      // `then` returned would hand back something that is not a promise.
      const settled = Promise.resolve(value).then(resolve, reject);
      return { then: settled.then.bind(settled) };
    }
  });

  it("returns a native promise for a callback returning another thenable", async () => {
    let judged: unknown;
    const { events } = await capture(async (recorder) => {
      const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
      const returned = journey.deliver("send", {}, () => thenable({ status: 422 }), {
        isFailure: (result) => {
          judged = result;
          return result.status >= 400;
        }
      });
      expect(returned).toBeInstanceOf(Promise);
      expect(await returned).toEqual({ status: 422 });
    });
    expect(judged).toEqual({ status: 422 });
    expect(events[0]).toMatchObject({
      operation: "delivered",
      output: { status: 422 },
      error: { code: "result_failed" }
    });
  });

  it("returns a native promise unchanged in behaviour", async () => {
    const recorder = offline();
    const journey = recorder.startJourney({ entity: { type: "t", id: "1" } });
    const error = new Error("boom");
    await expect(journey.persist("p", {}, () => Promise.reject(error))).rejects.toBe(error);
    await expect(journey.persist("p", {}, () => Promise.resolve(3))).resolves.toBe(3);
    await recorder.shutdown({ timeoutMs: 50 });
  });

  it("types what the wrappers return and what their options receive", () => {
    const journey = offline().startJourney({ entity: { type: "t", id: "1" } });
    const invoice = { id: "inv_1", total: 3 };

    expectTypeOf(journey.transform("sync", invoice, () => 1)).toEqualTypeOf<number>();
    expectTypeOf(journey.transform("async", invoice, () => Promise.resolve("x"))).toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf(journey.persist("thenable", invoice, () => thenable(true))).toEqualTypeOf<
      Promise<boolean>
    >();

    void journey.deliver("thenable", invoice, () => thenable({ status: 201 }), {
      isFailure: (result) => {
        expectTypeOf(result).toEqualTypeOf<{ status: number }>();
        return false;
      },
      captureInput: (input) => {
        expectTypeOf(input).toEqualTypeOf<{ id: string; total: number }>();
        return { id: input.id };
      },
      captureOutput: (result, context) => {
        expectTypeOf(result).toEqualTypeOf<{ status: number }>();
        expectTypeOf(context.entity).toEqualTypeOf<Entity>();
        return result.status;
      }
    });
  });

  it("accepts an explicit undefined for every optional input", () => {
    // Compiled with exactOptionalPropertyTypes, as a host may be.
    const secret: string | undefined = undefined;
    const config: RecorderConfig = {
      ...base,
      endpoint: "http://127.0.0.1:1",
      captureMode: undefined,
      redact: undefined,
      batchSize: undefined,
      flushIntervalMs: undefined,
      requestTimeoutMs: undefined,
      maxBufferedEvents: undefined,
      maxEventBytes: undefined,
      propagation: undefined,
      onDiagnostic: undefined,
      logDiagnostics: undefined,
      maxConcurrentSends: undefined,
      journeyIdSecret: secret,
      knownSafeNames: undefined
    };
    const recorder = createRecorder(config);
    const start: StartJourneyOptions = {
      entity: { type: "t", id: "1" },
      aliases: undefined,
      displayableAliases: undefined,
      label: undefined
    };
    const journey: Journey = recorder.startJourney(start);
    const wrap: WrapOptions<number, string> = {
      isFailure: undefined,
      attempt: undefined,
      metadata: undefined,
      captureInput: undefined,
      captureOutput: undefined
    };
    const input: RecordInput = {
      operation: "received",
      name: "r",
      input: undefined,
      output: undefined,
      error: { message: "m", type: undefined, code: undefined, stack: undefined },
      aliases: undefined,
      displayableAliases: undefined,
      metadata: undefined,
      durationMs: undefined,
      startedAt: undefined
    };
    const identify: IdentifyOptions = { displayableAliases: undefined };
    const fail: FailOptions = { metadata: undefined };
    const finish: FinishOptions = { status: undefined };
    const shutdown: ShutdownOptions = { timeoutMs: undefined };
    expect(() => {
      journey.transform("t", "in", () => 1, wrap);
      journey.record(input);
      journey.identify({ a: "b" }, identify);
      journey.fail("f", new Error("x"), fail);
      journey.finish(finish);
      void recorder.shutdown(shutdown);
    }).not.toThrow();
  });

  it("does not export TraceContext", () => {
    // The import above fails to compile, which is the check; unresolved, the
    // name is `any`.
    const absent: TraceContext = "anything";
    expect(absent).toBe("anything");
  });
});
