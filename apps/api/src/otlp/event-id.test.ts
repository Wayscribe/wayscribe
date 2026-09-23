import { createKeyring } from "@wayscribe/payload-security";
import { describe, expect, it } from "vitest";
import { otlpFallbackEventIds } from "./event-id.js";

const current = "0123456789abcdef0123456789abcdef";
const previous = "fedcba9876543210fedcba9876543210";

describe("OTLP fallback event ids", () => {
  it("is deterministic, keyed and content-sensitive", () => {
    const ids = otlpFallbackEventIds(createKeyring(current));
    const [first, ...rest] = ids('{"record":1}');
    expect(first).toMatch(/^otlp_[0-9a-f]{64}$/);
    expect(rest).toEqual([]);
    expect(ids('{"record":1}')).toEqual([first]);
    expect(ids('{"record":2}')[0]).not.toBe(first);
    // Keyed: another deployment's key derives another id from the same content.
    expect(otlpFallbackEventIds(createKeyring(previous))('{"record":1}')[0]).not.toBe(first);
  });

  it("offers the previous key's id during a rotation", () => {
    const before = otlpFallbackEventIds(createKeyring(previous))('{"record":1}')[0];
    const during = otlpFallbackEventIds(createKeyring(current, previous))('{"record":1}');
    expect(during).toEqual([
      otlpFallbackEventIds(createKeyring(current))('{"record":1}')[0],
      before
    ]);
  });
});
