import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  PAYLOAD_DEPTH,
  checkLimits,
  eventLimits,
  payloadLimits
} from "./limits.js";
import { MAX_STRING_LENGTH, truncateText } from "./truncate.js";

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
    // operator to raise maxEventBytes, a setting that cannot help.
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

/**
 * The limits ingestion applies, and the same limits as they fall on a payload.
 *
 * The SDK used to apply its own reading of these and the server refused what
 * the SDK had counted as fine. Both sides now call these two functions.
 */
describe("eventLimits and payloadLimits", () => {
  const nest = (depth: number): unknown => {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) value = { n: value };
    return value;
  };
  const envelopeAround = (input: unknown): unknown => ({
    protocolVersion: "0.1",
    event: { id: "evt_1", input }
  });

  it("is the shared default with the event byte budget", () => {
    expect(eventLimits(1_000)).toEqual({ ...DEFAULT_LIMITS, maxBytes: 1_000 });
    expect(DEFAULT_LIMITS.maxStringLength).toBe(MAX_STRING_LENGTH);
  });

  it("places a payload two levels below the envelope, so its depth budget is two less", () => {
    expect(PAYLOAD_DEPTH).toBe(2);
    expect(payloadLimits(262_144).maxDepth).toBe(DEFAULT_LIMITS.maxDepth - 2);

    // The two checks agree at the boundary, which is the whole point.
    for (const depth of [29, 30, 31, 32]) {
      const payload = nest(depth);
      expect(checkLimits(payload, payloadLimits(262_144)).ok, `depth ${String(depth)}`).toBe(
        checkLimits(envelopeAround(payload), eventLimits(262_144)).ok
      );
    }
    expect(checkLimits(nest(30), payloadLimits(262_144)).ok).toBe(true);
    expect(checkLimits(nest(31), payloadLimits(262_144)).ok).toBe(false);
  });

  it("does not refuse a long string it has been told will be truncated", () => {
    const payload = { note: "a".repeat(70_000) };
    expect(checkLimits(payload, eventLimits(262_144))).toEqual({
      ok: false,
      reason: "max_string_length_exceeded"
    });
    expect(checkLimits(payload, payloadLimits(262_144)).ok).toBe(true);
  });

  it("measures a long string at its truncated length", () => {
    // Four strings of 70,000 characters are 280 KB as they are and 262 KB
    // truncated, which fits a 270 KB budget only if the measurement is of the
    // truncated form. Five are over a 300 KB budget either way.
    const four = { list: Array.from({ length: 4 }, () => "a".repeat(70_000)) };
    expect(checkLimits(four, payloadLimits(270_000)).ok).toBe(true);
    const { truncateStringsTo: _unused, ...untruncated } = payloadLimits(270_000);
    expect(checkLimits(four, untruncated)).toEqual({
      ok: false,
      reason: "max_string_length_exceeded"
    });
    const five = { list: Array.from({ length: 5 }, () => "a".repeat(70_000)) };
    expect(checkLimits(five, payloadLimits(300_000))).toEqual({
      ok: false,
      reason: "payload_too_large"
    });
  });

  it("measures exactly what truncation produces", () => {
    const text = "é".repeat(70_000);
    const truncatedBytes = Buffer.byteLength(
      JSON.stringify({ t: truncateText(text, MAX_STRING_LENGTH) })
    );
    expect(checkLimits({ t: text }, payloadLimits(truncatedBytes)).ok).toBe(true);
    expect(checkLimits({ t: text }, payloadLimits(truncatedBytes - 1))).toEqual({
      ok: false,
      reason: "payload_too_large"
    });
  });
});
