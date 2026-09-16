import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appliesTo,
  compareExpectation,
  conformanceCaseSchema,
  expand,
  loadConformanceCases,
  type ConformanceCase
} from "./conformance.js";
import { parseEnvelope } from "./envelope.js";

const wireDirectory = fileURLToPath(new URL("../conformance/wire", import.meta.url));

describe("expanding a case", () => {
  const run = "r42";
  const expandWire = (value: unknown): unknown => expand(value, { run });

  it("substitutes {{run}} in values and in keys", () => {
    expect(expandWire({ "evt_{{run}}": "jrn_{{run}}" })).toEqual({ evt_r42: "jrn_r42" });
  });

  it("builds a long string without the file carrying it", () => {
    expect(expandWire({ $string: { char: "a", count: 70_000 } })).toBe("a".repeat(70_000));
  });

  it("builds an array past the key limit", () => {
    const built = expandWire({ $array: { value: 1, count: 1001 } }) as unknown[];
    expect(built.length).toBe(1001);
    expect(built[1000]).toBe(1);
  });

  it("builds a structure past the depth limit", () => {
    let node = expandWire({ $nest: { depth: 33, leaf: "bottom" } });
    let depth = 0;
    while (typeof node === "object" && node !== null) {
      node = (node as { n: unknown }).n;
      depth += 1;
    }
    expect(depth).toBe(33);
    expect(node).toBe("bottom");
  });

  it("gives each built array element its own object", () => {
    // Shared references would make a case about one element's redaction pass
    // because a different element was redacted.
    const built = expandWire({ $array: { value: { a: 1 }, count: 2 } }) as { a: number }[];
    expect(built[0]).not.toBe(built[1]);
  });

  it("escapes data that genuinely starts with $", () => {
    expect(expandWire({ $literal: { $string: "a price in {{run}}" } })).toEqual({
      $string: "a price in r42"
    });
  });

  it("keeps a __proto__ key as an own key", () => {
    // The whole point of one of the wire cases. A spread or an assignment here
    // would spend it on the prototype and the case would assert nothing.
    const built = expandWire(JSON.parse('{"aliases":{"__proto__":"p","b":"q"}}')) as {
      aliases: object;
    };
    expect(Object.hasOwn(built.aliases, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(built.aliases)).toBe(Object.prototype);
  });

  it("leaves a matcher alone, because it is compared and not built", () => {
    expect(expandWire({ id: { $matches: "^evt_" } })).toEqual({ id: { $matches: "^evt_" } });
  });

  it("refuses a host tag in a wire case", () => {
    // A request body cannot hold a Date, so a tag there is a mistake.
    expect(() => expandWire({ when: { $date: "2026-08-06T18:31:02.000Z" } })).toThrow(
      "only allowed in an sdk case"
    );
  });

  it("refuses a tag nobody defined", () => {
    expect(() => expandWire({ x: { $whatever: 1 } })).toThrow("Unknown tag");
  });

  describe("host values, for an sdk case", () => {
    const host = (value: unknown): unknown => expand(value, { run, host: true });

    it("builds the values JSON cannot write", () => {
      expect(host({ $date: "2026-08-06T18:31:02.000Z" })).toEqual(
        new Date("2026-08-06T18:31:02.000Z")
      );
      expect(host({ $bigint: "9007199254740993" })).toBe(9007199254740993n);
      expect(host({ $number: "NaN" })).toBeNaN();
      expect(host({ $number: "-Infinity" })).toBe(Number.NEGATIVE_INFINITY);
      expect(host({ $undefined: true })).toBeUndefined();
      expect(host({ $map: { a: 1 } })).toEqual(new Map([["a", 1]]));
      expect(host({ $set: [1, 2] })).toEqual(new Set([1, 2]));
      expect(host({ $buffer: "hi" })).toEqual(Buffer.from("hi", "utf8"));
    });

    it("builds a lone surrogate from code units", () => {
      const built = host({ $utf16: [0xd800] }) as string;
      expect(built.length).toBe(1);
      expect(built.codePointAt(0)).toBe(0xd800);
      expect(built.isWellFormed()).toBe(false);
    });

    it("builds a getter that throws when it is read", () => {
      const built = host({ $throwingGetter: "nope" }) as { value: unknown };
      expect(() => built.value).toThrow("nope");
    });

    it("closes a cycle at the node the pointer names", () => {
      const built = host({ name: "root", self: { $cycle: "#" } }) as { self: unknown };
      expect(built.self).toBe(built);
    });

    it("shares one object between two places", () => {
      const built = host({ first: { a: 1 }, second: { $ref: "#/first" } }) as {
        first: unknown;
        second: unknown;
      };
      expect(built.second).toBe(built.first);
    });
  });
});

describe("comparing against an expectation", () => {
  it("ignores a key the expectation does not list, at the top level only", () => {
    expect(compareExpectation({ a: 1, b: 2 }, { a: 1 })).toEqual([]);
  });

  it("requires a nested key set to match exactly, so a dropped field fails", () => {
    // The rule that matters. `not.toContain(secret)` passes against a field
    // that was deleted, which is the mistake this suite exists to prevent.
    expect(compareExpectation({ headers: { a: 1 } }, { headers: { a: 1, b: 2 } })).toEqual([
      "headers.b: expected to be present"
    ]);
    expect(compareExpectation({ headers: { a: 1, b: 2 } }, { headers: { a: 1 } })).toEqual([
      "headers.b: present and not expected"
    ]);
  });

  it("reports every problem rather than the first", () => {
    expect(compareExpectation({ a: 1, b: 2 }, { a: 9, b: 8 }).length).toBe(2);
  });

  it("matches a client-generated value by pattern", () => {
    expect(compareExpectation({ id: "evt_0199" }, { id: { $matches: "^evt_[0-9]+$" } })).toEqual(
      []
    );
    expect(compareExpectation({ id: "nope" }, { id: { $matches: "^evt_" } }).length).toBe(1);
    expect(compareExpectation({ id: 7 }, { id: { $matches: "^evt_" } }).length).toBe(1);
  });

  it("asserts a field is not there", () => {
    expect(compareExpectation({ message: "x" }, { stack: { $absent: true } })).toEqual([]);
    expect(compareExpectation({ stack: "at ..." }, { stack: { $absent: true } })).toEqual([
      "stack: expected to be absent"
    ]);
  });

  it("does not count an absent expectation as an unlisted key", () => {
    expect(
      compareExpectation(
        { error: { message: "x" } },
        { error: { message: "x", stack: { $absent: true } } }
      )
    ).toEqual([]);
  });

  it("compares arrays by length and position", () => {
    expect(compareExpectation({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(compareExpectation({ a: [1] }, { a: [1, 2] }).length).toBe(1);
    expect(compareExpectation({ a: [2, 1] }, { a: [1, 2] }).length).toBe(2);
  });

  it("tells null from a missing key", () => {
    expect(compareExpectation({ a: null }, { a: null })).toEqual([]);
    expect(compareExpectation({}, { a: null })).toEqual(["a: expected to be present"]);
  });
});

describe("the committed wire cases", () => {
  const cases = loadConformanceCases(wireDirectory);

  it("loads them all, sorted by id", () => {
    expect(cases.length).toBeGreaterThan(20);
    expect([...cases].map((one) => one.id)).toEqual([...cases].map((one) => one.id).sort());
  });

  it("gives every case a unique id", () => {
    expect(new Set(cases.map((one) => one.id)).size).toBe(cases.length);
  });

  it.each(cases.map((one) => [one.id, one] as const))("%s names a source", (_id, one) => {
    expect(one.source.length).toBeGreaterThan(3);
    expect(one.layer).toBe("wire");
    // A wire case is a request body, which any language can write.
    expect(one.languages).toEqual(["*"]);
  });

  it("fails a case with a key nobody defined", () => {
    // The control: a typo in a case must be a failing test, not an expectation
    // that quietly never runs.
    const good = cases[0] as ConformanceCase;
    const typo = { ...good, expects: good.expect };
    expect(conformanceCaseSchema.safeParse(typo).success).toBe(false);
  });

  it("fails a wire case that carries recorder calls", () => {
    const good = cases[0] as ConformanceCase;
    expect(conformanceCaseSchema.safeParse({ ...good, calls: [{ call: "record" }] }).success).toBe(
      false
    );
  });

  it("expands every envelope the cases send into something the parser agrees with", () => {
    // The parity test (json-schema.test.ts) validates these with both
    // validators; this one only asserts that the expansion produces an envelope
    // at all, so a case cannot assert on a body the parser never saw.
    for (const one of cases) {
      for (const envelope of expandedEnvelopes(one)) {
        const parsed = parseEnvelope(envelope);
        const expectsRefusal =
          one.expect.request !== undefined ||
          (one.expect.results ?? []).some((result) => result.status === "rejected");
        if (parsed.ok) continue;
        expect(expectsRefusal, `${one.id}: the parser refuses an envelope no result refuses`).toBe(
          true
        );
      }
    }
  });

  it("applies to every language", () => {
    expect(cases.every((one) => appliesTo(one, "python"))).toBe(true);
  });
});

/** Every envelope a case puts on the wire, expanded. */
export function expandedEnvelopes(one: ConformanceCase): unknown[] {
  const run = "fixture";
  return [
    ...(one.setup?.existing ?? []),
    ...(one.setup?.otherEnvironment ?? []),
    ...(Array.isArray(one.send?.events) ? (one.send.events as unknown[]) : [])
  ].map((envelope) => expand(envelope, { run }));
}
