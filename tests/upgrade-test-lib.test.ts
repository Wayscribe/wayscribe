import { describe, expect, it } from "vitest";
import { containedIn, releaseTags } from "../scripts/upgrade-test-lib.mjs";

describe("releaseTags, the upgrade test's baseline candidates", () => {
  it("keeps only vMAJOR.MINOR.PATCH tags, newest first", () => {
    expect(
      releaseTags([
        "v1.0.0-rc.1",
        "v1.0.0",
        "phase-6-complete",
        "v1.0.1",
        "usable-v0",
        "v1.0.1-rc.2",
        "v2.0.0-beta"
      ])
    ).toEqual(["v1.0.1", "v1.0.0"]);
  });

  it("orders by number, not by text", () => {
    expect(releaseTags(["v1.9.0", "v1.10.0", "v1.2.10", "v1.2.9", "v0.99.99"])).toEqual([
      "v1.10.0",
      "v1.9.0",
      "v1.2.10",
      "v1.2.9",
      "v0.99.99"
    ]);
  });

  it("refuses near misses", () => {
    expect(releaseTags(["1.0.0", "v1.0", "v1.0.0.1", "V1.0.0", "v1.0.0 ", "xv1.0.0"])).toEqual([]);
  });
});

describe("containedIn, the upgrade test's comparison", () => {
  const compare = (
    expected: unknown,
    actual: unknown,
    headerMaps: ReadonlySet<string> = new Set()
  ): string[] => {
    const mismatches: string[] = [];
    containedIn(expected, actual, "read", mismatches, headerMaps);
    return mismatches;
  };

  it("allows fields the current build added", () => {
    expect(compare({ a: 1 }, { a: 1, environment: "production" })).toEqual([]);
  });

  it("reports a changed, missing, or lost value by path", () => {
    expect(compare({ a: { b: [1, 2] }, c: "x" }, { a: { b: [1] } })).toEqual([
      "read.a.b: expected 2 items, got 1",
      "read.a.b[1]: expected 2, got undefined",
      'read.c: missing (baseline had "x")'
    ]);
  });

  it("does not accept [REDACTED] outside a header map", () => {
    expect(compare({ entity: { id: "cust-1" } }, { entity: { id: "[REDACTED]" } })).toEqual([
      'read.entity.id: expected "cust-1", got "[REDACTED]"'
    ]);
  });

  describe("in a header map", () => {
    const maps = new Set(["read.requestHeaders"]);
    const sent = { "content-type": "application/json", "x-marker": "secret" };

    it("accepts values that became [REDACTED]", () => {
      expect(
        compare(
          { requestHeaders: sent },
          { requestHeaders: { "content-type": "[REDACTED]", "x-marker": "[REDACTED]" } },
          maps
        )
      ).toEqual([]);
    });

    it("still requires the same names", () => {
      expect(
        compare(
          { requestHeaders: sent },
          { requestHeaders: { "content-type": "[REDACTED]" } },
          maps
        )
      ).toEqual([
        'read.requestHeaders: header names ["content-type"], expected ["content-type","x-marker"]'
      ]);
    });

    it("rejects a value that changed to anything else", () => {
      expect(
        compare(
          { requestHeaders: sent },
          { requestHeaders: { "content-type": "text/plain", "x-marker": "secret" } },
          maps
        )
      ).toEqual([
        'read.requestHeaders.content-type: expected "application/json" or [REDACTED], got "text/plain"'
      ]);
    });
  });
});
