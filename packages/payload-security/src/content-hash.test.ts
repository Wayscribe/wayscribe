import { createHash, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentHash, contentHashMatches, legacyContentHash } from "./content-hash.js";
import { createKeyring } from "./keyring.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyringA = createKeyring(KEY_A);
const rotated = createKeyring(KEY_B, KEY_A);
const keyringB = createKeyring(KEY_B);

describe("legacyContentHash", () => {
  it("is stable regardless of key order", () => {
    expect(legacyContentHash({ a: 1, b: 2 })).toBe(legacyContentHash({ b: 2, a: 1 }));
  });

  it("is stable for nested key order", () => {
    expect(legacyContentHash({ o: { a: 1, b: 2 } })).toBe(legacyContentHash({ o: { b: 2, a: 1 } }));
  });

  it("differs when a value changes", () => {
    expect(legacyContentHash({ a: 1 })).not.toBe(legacyContentHash({ a: 2 }));
  });

  it("distinguishes a number from its string form", () => {
    expect(legacyContentHash({ a: 1 })).not.toBe(legacyContentHash({ a: "1" }));
  });

  it("preserves array order", () => {
    expect(legacyContentHash([1, 2])).not.toBe(legacyContentHash([2, 1]));
  });

  it("returns lowercase hex of fixed length", () => {
    expect(legacyContentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles null and empty structures", () => {
    expect(legacyContentHash(null)).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyContentHash({})).not.toBe(legacyContentHash([]));
  });
});

describe("contentHash", () => {
  it("names its version and the key that wrote it", () => {
    expect(contentHash(keyringA, { a: 1 })).toMatch(
      new RegExp(`^h1\\.${keyringA.current.id}\\.[0-9a-f]{64}$`)
    );
  });

  it("is written under the current key during a rotation", () => {
    expect(contentHash(rotated, { a: 1 }).startsWith(`h1.${keyringB.current.id}.`)).toBe(true);
  });

  it("keeps the canonical form: key order does not matter, values do", () => {
    expect(contentHash(keyringA, { a: 1, b: 2 })).toBe(contentHash(keyringA, { b: 2, a: 1 }));
    expect(contentHash(keyringA, { a: 1 })).not.toBe(contentHash(keyringA, { a: 2 }));
  });

  it("differs under a different key", () => {
    const digest = (value: string): string => value.split(".")[2] ?? "";
    expect(digest(contentHash(keyringA, { a: 1 }))).not.toBe(
      digest(contentHash(keyringB, { a: 1 }))
    );
  });

  it("is keyed under its own HKDF label", () => {
    const subkey = Buffer.from(hkdfSync("sha256", KEY_A, "", "flight-recorder/content-hash", 32));
    const canonical = '{"a":1}';
    const expected = createHmac("sha256", subkey).update(canonical, "utf8").digest("hex");
    expect(contentHash(keyringA, { a: 1 })).toBe(`h1.${keyringA.current.id}.${expected}`);
  });

  it("is no longer an offline oracle for a masked secret", () => {
    // The security review's reproduction: an error message carrying a
    // dictionary password is masked before storage, but the hash covered the
    // event as received. Rebuilding the event with each candidate and comparing
    // unkeyed SHA-256 recovered the password from a database read alone.
    const event = (password: string): unknown => ({
      id: "evt_oracle",
      journeyId: "jrn_oracle",
      environment: "production",
      service: "oracle",
      entity: { type: "customer", id: "oracle-1" },
      operation: "failed",
      name: "db-connect",
      timestamp: "2026-09-15T10:00:00.000Z",
      error: {
        type: "Error",
        message: `connect ECONNREFUSED postgres://app:${password}@db.internal:5432/orders`
      }
    });
    const stored = contentHash(keyringA, event("sunshine"));
    const storedDigest = stored.split(".")[2];

    const dictionary = ["password", "letmein", "hunter2", "dragon", "sunshine", "qwerty"];
    const hits = dictionary.filter((guess) => {
      const unkeyed = createHash("sha256")
        .update(JSON.stringify(event(guess)), "utf8")
        .digest("hex");
      return (
        unkeyed === storedDigest ||
        legacyContentHash(event(guess)) === storedDigest ||
        legacyContentHash(event(guess)) === stored
      );
    });
    expect(hits).toEqual([]);
  });
});

describe("contentHashMatches", () => {
  const event = { id: "evt_1", name: "transform" };
  const changed = { id: "evt_1", name: "different" };

  it("matches an identical resend under the current key", () => {
    const stored = contentHash(keyringA, event);
    expect(contentHashMatches(keyringA, event, stored)).toBe(true);
    expect(contentHashMatches(keyringA, changed, stored)).toBe(false);
  });

  it("matches a hash written under the previous key during a rotation", () => {
    const stored = contentHash(keyringA, event);
    expect(contentHashMatches(rotated, event, stored)).toBe(true);
    expect(contentHashMatches(rotated, changed, stored)).toBe(false);
  });

  it("matches a legacy unprefixed hash by computing the unkeyed hash", () => {
    const stored = legacyContentHash(event);
    expect(contentHashMatches(keyringB, event, stored)).toBe(true);
    expect(contentHashMatches(keyringB, changed, stored)).toBe(false);
  });

  it("cannot match a hash under a key that is no longer configured", () => {
    // Documented: a resend of an event older than the rotation grace period is
    // refused with 409, which only affects a duplicate delivery.
    expect(contentHashMatches(keyringB, event, contentHash(keyringA, event))).toBe(false);
  });

  it("does not match a malformed stored value", () => {
    const valid = contentHash(keyringA, event);
    for (const stored of [
      "",
      "h1.",
      `h1.${keyringA.current.id}`,
      `${valid}0`,
      valid.toUpperCase()
    ]) {
      expect(contentHashMatches(keyringA, event, stored)).toBe(false);
    }
  });
});
