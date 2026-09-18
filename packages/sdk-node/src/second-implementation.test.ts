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
      expect(hasJourney(value as PayloadEnvelope<unknown>)).toBe(false);
    }
    expect(hasJourney({ _wayscribe: { journeyId: "jrn_1" }, data: 1 })).toBe(true);
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
});
