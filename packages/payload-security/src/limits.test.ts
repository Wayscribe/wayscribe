import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, checkLimits } from "./limits.js";

describe("checkLimits", () => {
  it("accepts a small payload", () => {
    expect(checkLimits({ a: 1 }, DEFAULT_LIMITS).ok).toBe(true);
  });

  it("rejects a payload over the byte limit", () => {
    const big = { blob: "x".repeat(1_000) };
    const result = checkLimits(big, { ...DEFAULT_LIMITS, maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload_too_large");
  });

  it("rejects excessive nesting", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) nested = { nested };
    const result = checkLimits(nested, { ...DEFAULT_LIMITS, maxDepth: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_depth_exceeded");
  });

  it("rejects too many keys", () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i)}`, i]));
    const result = checkLimits(wide, { ...DEFAULT_LIMITS, maxKeys: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_keys_exceeded");
  });

  it("rejects an oversized string", () => {
    const result = checkLimits({ s: "x".repeat(200) }, { ...DEFAULT_LIMITS, maxStringLength: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_string_length_exceeded");
  });

  it("does not hang on cyclic input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => checkLimits(cyclic, DEFAULT_LIMITS)).not.toThrow();
  });
});
