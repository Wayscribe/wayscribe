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

  it("measures what is inside a Map rather than waving it through", () => {
    // A Map has no own enumerable properties, so every cap saw `{}` and passed
    // it. That was harmless only while a Map also stored as `{}`; now that its
    // contents are kept, a guard that cannot see them is a guard in name only.
    const wide = new Map(Array.from({ length: 2_000 }, (_, i) => [`k${String(i)}`, i]));
    const wideResult = checkLimits({ wide }, { ...DEFAULT_LIMITS, maxKeys: 100 });
    expect(wideResult.ok).toBe(false);
    if (!wideResult.ok) expect(wideResult.reason).toBe("max_keys_exceeded");

    const bulky = new Map([["blob", "x".repeat(5_000)]]);
    const bulkyResult = checkLimits({ bulky }, { ...DEFAULT_LIMITS, maxBytes: 500 });
    expect(bulkyResult.ok).toBe(false);
    if (!bulkyResult.ok) expect(bulkyResult.reason).toBe("payload_too_large");
  });

  it("measures a chain of Maps for depth", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) nested = new Map([["next", nested]]);
    const result = checkLimits(nested, { ...DEFAULT_LIMITS, maxDepth: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("max_depth_exceeded");
  });

  it("measures inside a Set and an error's config", () => {
    const set = new Set([{ blob: "x".repeat(2_000) }]);
    expect(checkLimits({ set }, { ...DEFAULT_LIMITS, maxBytes: 500 }).ok).toBe(false);

    const failure = Object.assign(new Error("boom"), { config: { blob: "x".repeat(2_000) } });
    expect(checkLimits({ failure }, { ...DEFAULT_LIMITS, maxBytes: 500 }).ok).toBe(false);
  });

  it("does not recurse forever on a cycle through a Map", () => {
    // The measurement renders each value once and reuses it. Rendering twice
    // would produce two objects, so the loop would never close on identity and
    // this would run until the stack gave out.
    const loop = new Map<string, unknown>();
    loop.set("self", loop);
    expect(checkLimits({ loop }, DEFAULT_LIMITS).ok).toBe(true);
  });

  it("still expands the same Map under two sibling keys", () => {
    // The control on the memo: reusing a rendering must not turn a shared
    // reference into a cycle, or a payload twice the size measures as half.
    const shared = new Map([["blob", "x".repeat(200)]]);
    const result = checkLimits({ a: shared, b: shared }, { ...DEFAULT_LIMITS, maxBytes: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload_too_large");
  });

  it("still accepts a small Map", () => {
    // The control: a change that rejected every exotic value would pass all of
    // the above.
    expect(checkLimits({ m: new Map([["a", 1]]), s: new Set([1]) }, DEFAULT_LIMITS).ok).toBe(true);
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
