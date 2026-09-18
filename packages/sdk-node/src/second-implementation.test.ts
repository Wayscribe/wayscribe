import { describe, expect, expectTypeOf, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import {
  createRecorder,
  hasJourney,
  type ContextEnvelope,
  type JourneyOperations,
  type NoContextEnvelope,
  type PayloadEnvelope,
  type RecorderConfig,
  type WrapResult
} from "./index.js";

/**
 * What a second implementation of the SDK's own types has to write, and what
 * a journey with neither a context nor an id falls back to (F-005, F-014,
 * F-021, ADR-060).
 *
 * Leadline wrote a recorder that records nothing, against these types. It
 * needed `as unknown as` for the no-context envelope the SDK itself produces,
 * and had to restate each wrapper's two overloads to be assignable to them.
 */

const base: RecorderConfig = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "production"
};

const SECRET = "a secret of at least thirty-two bytes, for tests";

function recorderWith(settings: Partial<RecorderConfig>): {
  recorder: ReturnType<typeof createRecorder>;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...settings
  });
  return { recorder, diagnostics };
}

describe("continueJourney with neither a context nor an id", () => {
  it("derives the id from the entity when a secret is configured", () => {
    const { recorder, diagnostics } = recorderWith({ journeyIdSecret: SECRET });
    const entity = { type: "lead", id: "lead_1" };
    const journey = recorder.continueJourney({ entity });
    expect(journey.context().journeyId).toBe(recorder.journeyIdFor(entity));
    // Nothing is reported: this is what the caller asked for.
    expect(diagnostics.filter((d) => d.kind === "configuration_error")).toEqual([]);
  });

  it("gives the same journey to two processes that know the same record", () => {
    const entity = { type: "lead", id: "lead_2" };
    const first = recorderWith({ journeyIdSecret: SECRET }).recorder.continueJourney({ entity });
    const second = recorderWith({ journeyIdSecret: SECRET }).recorder.continueJourney({ entity });
    expect(first.context().journeyId).toBe(second.context().journeyId);
  });

  it("derives it when the context carried no usable id either", () => {
    const { recorder } = recorderWith({ journeyIdSecret: SECRET });
    const entity = { type: "lead", id: "lead_3" };
    const journey = recorder.continueJourney({
      context: { journeyId: "" },
      entity
    });
    expect(journey.context().journeyId).toBe(recorder.journeyIdFor(entity));
  });

  it("still starts a new journey without a secret, and says nothing about it", () => {
    const { recorder, diagnostics } = recorderWith({});
    const entity = { type: "lead", id: "lead_4" };
    const first = recorder.continueJourney({ entity }).context().journeyId;
    const second = recorder.continueJourney({ entity }).context().journeyId;
    expect(first).toMatch(/^jrn_/);
    expect(first).not.toBe(second);
    // Not a misconfiguration: a recorder without a secret is the default.
    expect(diagnostics.filter((d) => d.code === "journey_id_secret_missing")).toEqual([]);
  });

  it("does not derive from an entity the server would refuse", () => {
    const { recorder } = recorderWith({ journeyIdSecret: SECRET });
    const journey = recorder.continueJourney({ entity: { type: "", id: "" } });
    expect(journey.context().journeyId).toMatch(/^jrn_/);
    expect(journey.context().entity).toEqual({ type: "unknown", id: "unknown" });
  });

  it("prefers the context's id over a journeyId and the derived one", () => {
    const { recorder } = recorderWith({ journeyIdSecret: SECRET });
    const entity = { type: "lead", id: "lead_6" };
    const journey = recorder.continueJourney({
      context: { journeyId: "jrn_carried" },
      journeyId: "jrn_given",
      entity
    });
    expect(journey.context().journeyId).toBe("jrn_carried");
  });

  it("derives past a journeyId it cannot use, and still reports it", () => {
    const { recorder, diagnostics } = recorderWith({ journeyIdSecret: SECRET });
    const entity = { type: "lead", id: "lead_7" };
    const journey = recorder.continueJourney({ journeyId: 7 as never, entity });
    expect(journey.context().journeyId).toBe(recorder.journeyIdFor(entity));
    expect(diagnostics.map((d) => d.code)).toContain("journey_id_invalid");
  });

  it("prefers a journey id the caller gave over the derived one", () => {
    const { recorder } = recorderWith({ journeyIdSecret: SECRET });
    const entity = { type: "lead", id: "lead_5" };
    const journey = recorder.continueJourney({ journeyId: "jrn_given", entity });
    expect(journey.context().journeyId).toBe("jrn_given");
  });
});

describe("the no-context envelope", () => {
  it("type-checks as the SDK's own value, with no cast", () => {
    const withoutJourney: NoContextEnvelope<{ id: string }> = {
      _wayscribe: {},
      data: { id: "1" }
    };
    const either: PayloadEnvelope<{ id: string }> = withoutJourney;
    expectTypeOf(either).toExtend<PayloadEnvelope<{ id: string }>>();
    expect(either.data).toEqual({ id: "1" });

    const withJourney: ContextEnvelope<{ id: string }> = {
      _wayscribe: { journeyId: "jrn_1" },
      data: { id: "1" }
    };
    // A reader that wants the journey id reads it from either shape, with no
    // cast and no check of its own: it is `string | undefined` on the union.
    const journeyIdOf = (envelope: PayloadEnvelope<{ id: string }>): string | undefined => {
      const id = envelope._wayscribe.journeyId;
      expectTypeOf(id).toEqualTypeOf<string | undefined>();
      return id;
    };
    expect(journeyIdOf(withJourney)).toBe("jrn_1");
    expect(journeyIdOf(withoutJourney)).toBeUndefined();

    // TypeScript does not narrow a union on a nested property, so checking
    // `_wayscribe.journeyId` leaves the value typed as the union. `hasJourney`
    // is the narrowing, and needs no cast of the caller's own.
    const contextOf = (
      envelope: PayloadEnvelope<{ id: string }>
    ): ContextEnvelope<{ id: string }> | undefined => {
      if (!hasJourney(envelope)) return undefined;
      expectTypeOf(envelope).toEqualTypeOf<ContextEnvelope<{ id: string }>>();
      expectTypeOf(envelope._wayscribe.journeyId).toEqualTypeOf<string>();
      return envelope;
    };
    expect(contextOf(withJourney)).toBe(withJourney);
    expect(contextOf(withoutJourney)).toBeUndefined();
  });

  it("takes a body typed unknown with no cast, and narrows it (F-034)", () => {
    // A body off a queue is `unknown`. Declared as taking an envelope, this
    // call needed the cast the guard exists to remove; `pnpm typecheck` is
    // what fails if the parameter narrows again.
    const journeyIdOf = (body: unknown): string | undefined => {
      if (!hasJourney(body)) return undefined;
      expectTypeOf(body).toEqualTypeOf<ContextEnvelope<unknown>>();
      expectTypeOf(body._wayscribe.journeyId).toEqualTypeOf<string>();
      return body._wayscribe.journeyId;
    };
    expect(journeyIdOf(JSON.parse('{"_wayscribe":{"journeyId":"jrn_1"},"data":1}'))).toBe("jrn_1");

    // No type parameter: the guard never reads `data`, so one the caller set
    // would assert the payload's type unchecked, a cast by another name
    // (ADR-062).
    // @ts-expect-error TS2558: hasJourney takes no type argument.
    expect(hasJourney<{ id: string }>({})).toBe(false);

    // A typed envelope keeps its payload type on both sides of the guard.
    const sides = (envelope: PayloadEnvelope<{ id: string }>): string | undefined => {
      if (hasJourney(envelope)) {
        expectTypeOf(envelope).toEqualTypeOf<ContextEnvelope<{ id: string }>>();
        return envelope.data.id;
      }
      expectTypeOf(envelope).toEqualTypeOf<NoContextEnvelope<{ id: string }>>();
      return undefined;
    };
    expect(sides({ _wayscribe: { journeyId: "jrn_1" }, data: { id: "1" } })).toBe("1");

    // `false` is both "not an envelope" and "an envelope with no journey":
    // a caller that must tell those apart reads `_wayscribe` itself, or
    // calls `extractPayload`.
    expect(hasJourney({ a: 1 })).toBe(false);
    expect(hasJourney({ _wayscribe: {}, data: { a: 1 } })).toBe(false);
  });

  it("says no journey for anything that is not an envelope with one", () => {
    // A host can pass anything, and this runs on a body from the network.
    for (const value of [
      { _wayscribe: {}, data: 1 },
      { _wayscribe: { journeyId: "" }, data: 1 },
      { _wayscribe: { journeyId: 7 }, data: 1 },
      { _wayscribe: null, data: 1 },
      { data: 1 },
      null,
      "no",
      undefined
    ]) {
      expect(hasJourney(value)).toBe(false);
    }
    expect(hasJourney({ _wayscribe: { journeyId: "jrn_1" }, data: 1 })).toBe(true);
  });

  it("answers false rather than throwing for a value that cannot be read", () => {
    // `hasJourney` is a public entry point, and the README promises none of
    // them propagates into the caller's code. A JSON body off a queue carries
    // no getters, but the guard takes whatever was put there.
    const throwing = (): never => {
      throw new Error("no");
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile: unknown[] = [
      // A throwing getter on the envelope.
      Object.defineProperty({}, "_wayscribe", { get: throwing, enumerable: true }),
      // A throwing getter on the journey id.
      { _wayscribe: Object.defineProperty({}, "journeyId", { get: throwing, enumerable: true }) },
      // A revoked Proxy, whose every read throws.
      revoked.proxy,
      // A Proxy whose get trap throws.
      new Proxy({}, { get: throwing })
    ];
    for (const value of hostile) {
      expect(() => hasJourney(value)).not.toThrow();
      expect(hasJourney(value)).toBe(false);
    }
  });

  it("is what injectPayload returns when there is no journey to inject", () => {
    const { recorder } = recorderWith({});
    const envelope: PayloadEnvelope<{ id: string }> = recorder.injectPayload(
      { id: "1" },
      undefined as never
    );
    expect(envelope).toEqual({ _wayscribe: {}, data: { id: "1" } });
    expect(recorder.extractPayload(envelope).context).toBeUndefined();
  });
});

describe("a second implementation of JourneyOperations", () => {
  it("needs one signature per wrapper, and no cast to be assignable", () => {
    // What a recorder that records nothing looks like: run the callback, hand
    // back a value as a value and a thenable as a native promise. One
    // signature, not two, and assigned to all four wrappers directly.
    function runOnly<T>(_name: string, _input: unknown, fn: () => T): WrapResult<T> {
      const produced = fn();
      const isThenable =
        typeof produced === "object" &&
        produced !== null &&
        typeof (produced as { then?: unknown }).then === "function";
      return (isThenable ? Promise.resolve(produced) : produced) as WrapResult<T>;
    }

    const operations: JourneyOperations = {
      record: () => undefined,
      transform: runOnly,
      persist: runOnly,
      publish: runOnly,
      deliver: runOnly,
      fail: () => undefined,
      finish: () => undefined
    };

    expect(operations.transform("t", 1, () => 2)).toBe(2);
    expectTypeOf(operations.transform("t", 1, () => 2)).toEqualTypeOf<number>();
    expectTypeOf(operations.persist("p", 1, () => Promise.resolve("x"))).toEqualTypeOf<
      Promise<string>
    >();
  });

  it("still casts its own return: the conditional cannot resolve inside the body (F-037)", () => {
    // `WrapResult`'s documentation says the assignment above needs no cast and
    // the implementation's return still does. If TypeScript ever resolves the
    // conditional while `T` is a type parameter, these directives become
    // unused, `pnpm typecheck` fails, and the sentence has to change with them.
    function runOnly<T>(_name: string, _input: unknown, fn: () => T): WrapResult<T> {
      const produced = fn();
      if (typeof (produced as { then?: unknown } | null)?.then === "function") {
        // @ts-expect-error TS2322: a promise is not assignable to the unresolved conditional.
        return Promise.resolve(produced);
      }
      // @ts-expect-error TS2322: nor is `T` itself.
      return produced;
    }
    expect(runOnly("t", 1, () => 2)).toBe(2);
  });
});
