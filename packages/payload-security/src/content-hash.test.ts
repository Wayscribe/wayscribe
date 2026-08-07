import { describe, expect, it } from "vitest";
import { contentHash } from "./content-hash.js";

describe("contentHash", () => {
  it("is stable regardless of key order", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("is stable for nested key order", () => {
    expect(contentHash({ o: { a: 1, b: 2 } })).toBe(contentHash({ o: { b: 2, a: 1 } }));
  });

  it("differs when a value changes", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it("distinguishes a number from its string form", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: "1" }));
  });

  it("preserves array order", () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it("returns lowercase hex of fixed length", () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles null and empty structures", () => {
    expect(contentHash(null)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({})).not.toBe(contentHash([]));
  });
});
