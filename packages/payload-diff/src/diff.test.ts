import { describe, expect, it } from "vitest";
import { diffPayloads } from "./diff.js";

describe("diffPayloads", () => {
  it("reports a changed scalar", () => {
    const result = diffPayloads({ phone: "+1 919 555 1234" }, { phone: null });
    expect(result.changes).toEqual([
      { path: "phone", kind: "changed", before: "+1 919 555 1234", after: null }
    ]);
  });

  it("reports added and removed keys", () => {
    const result = diffPayloads({ a: 1 }, { b: 2 });
    expect(result.changes).toContainEqual({ path: "a", kind: "removed", before: 1 });
    expect(result.changes).toContainEqual({ path: "b", kind: "added", after: 2 });
  });

  it("reports nothing for equal values", () => {
    expect(diffPayloads({ a: { b: 1 } }, { a: { b: 1 } }).changes).toEqual([]);
  });

  it("uses dotted paths for nested changes", () => {
    const result = diffPayloads({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expect(result.changes).toEqual([{ path: "a.b.c", kind: "changed", before: 1, after: 2 }]);
  });

  it("compares arrays by index", () => {
    const result = diffPayloads({ xs: [1, 2] }, { xs: [1, 3] });
    expect(result.changes).toEqual([{ path: "xs[1]", kind: "changed", before: 2, after: 3 }]);
  });

  it("reports a reordered array as changed, per ADR-025", () => {
    // Documented limitation: no subsequence matching in V0.
    const result = diffPayloads({ xs: [1, 2] }, { xs: [2, 1] });
    expect(result.changes.length).toBe(2);
  });

  it("reports array length differences", () => {
    expect(diffPayloads({ xs: [1] }, { xs: [1, 2] }).changes).toEqual([
      { path: "xs[1]", kind: "added", after: 2 }
    ]);
  });

  it("treats a type change as changed", () => {
    const result = diffPayloads({ a: 1 }, { a: "1" });
    expect(result.changes).toEqual([{ path: "a", kind: "changed", before: 1, after: "1" }]);
  });

  it("truncates rather than walking an unbounded structure", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${String(i)}`, i]));
    const result = diffPayloads({}, wide, { maxChanges: 10 });
    expect(result.changes.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("handles null and undefined inputs", () => {
    expect(diffPayloads(null, null).changes).toEqual([]);
    expect(diffPayloads(undefined, { a: 1 }).changes).toContainEqual({
      path: "",
      kind: "changed",
      before: undefined,
      after: { a: 1 }
    });
  });
});
