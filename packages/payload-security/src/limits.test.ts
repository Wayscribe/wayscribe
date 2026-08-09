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

  it("accepts a cyclic payload rather than blaming its size", () => {
    // `redact` cuts cycles to [CIRCULAR] and stores the rest, so a parent/child
    // graph — an ORM entity, an Express req — is entirely capturable. This ran
    // first and rejected it, which made that repair unreachable and told the
    // operator to raise maxPayloadBytes, a setting that cannot help.
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    expect(checkLimits(cyclic, DEFAULT_LIMITS).ok).toBe(true);
  });

  it("accepts a BigInt rather than blaming its size", () => {
    // A Postgres bigint column, a snowflake id. `toStorable` renders it as a
    // decimal string; measuring it as one keeps this check and storage agreed.
    expect(checkLimits({ id: 9_007_199_254_740_993n }, DEFAULT_LIMITS).ok).toBe(true);
  });

  it("still measures a cyclic payload's real size", () => {
    // The control for the two above: tolerating a cycle must not mean skipping
    // the byte check, or any oversized payload could smuggle itself through by
    // carrying a self-reference.
    const cyclic: Record<string, unknown> = { blob: "x".repeat(1_000) };
    cyclic["self"] = cyclic;
    const result = checkLimits(cyclic, { ...DEFAULT_LIMITS, maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload_too_large");
  });

  it("expands a shared reference instead of treating it as a cycle", () => {
    // Two fields pointing at one object is ordinary, not a loop. Counting the
    // second as [CIRCULAR] would under-measure a payload that is genuinely
    // twice the size.
    const shared = { blob: "x".repeat(200) };
    const result = checkLimits(
      { billing: shared, shipping: shared },
      {
        ...DEFAULT_LIMITS,
        maxBytes: 300
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload_too_large");
  });

  it("names the real problem when a value cannot be serialized at all", () => {
    // A getter or toJSON that throws is not a size problem, and reporting one
    // sends the operator to a setting that will not fix it.
    const hostile = {
      toJSON() {
        throw new Error("boom");
      }
    };
    const result = checkLimits(hostile, DEFAULT_LIMITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unserialisable_payload");
  });
});
