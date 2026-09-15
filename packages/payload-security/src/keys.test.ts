import { describe, expect, it } from "vitest";
import { deriveSubkeys, keyFingerprint } from "./keys.js";

const master = "0123456789abcdef0123456789abcdef";

describe("deriveSubkeys", () => {
  it("derives three 32-byte subkeys", () => {
    const keys = deriveSubkeys(master);
    expect(keys.fieldEncryption).toHaveLength(32);
    expect(keys.searchToken).toHaveLength(32);
    expect(keys.apiKey).toHaveLength(32);
  });

  it("derives different keys for different purposes", () => {
    const keys = deriveSubkeys(master);
    expect(keys.fieldEncryption.equals(keys.searchToken)).toBe(false);
    expect(keys.searchToken.equals(keys.apiKey)).toBe(false);
    expect(keys.fieldEncryption.equals(keys.apiKey)).toBe(false);
  });

  it("is deterministic for the same master", () => {
    expect(deriveSubkeys(master).searchToken.equals(deriveSubkeys(master).searchToken)).toBe(true);
  });

  it("produces different subkeys for a different master", () => {
    const other = deriveSubkeys("fedcba9876543210fedcba9876543210");
    expect(deriveSubkeys(master).searchToken.equals(other.searchToken)).toBe(false);
  });

  it("rejects a master key that is too short", () => {
    expect(() => deriveSubkeys("short")).toThrow(/at least 32/i);
  });
});

describe("keyFingerprint", () => {
  it("is 12 lowercase hex characters", () => {
    expect(keyFingerprint(master)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable across releases", () => {
    // Every stored envelope and API key row carries this value. A change to the
    // derivation would make all of them look like they were written under a key
    // that no longer exists, so the exact output is pinned.
    expect(keyFingerprint(master)).toBe("94751d395da0");
    expect(keyFingerprint("fedcba9876543210fedcba9876543210")).toBe("367d1196a8e7");
  });

  it("differs for a different master", () => {
    expect(keyFingerprint(master)).not.toBe(keyFingerprint("fedcba9876543210fedcba9876543210"));
  });

  it("is independent of the subkeys", () => {
    // The fingerprint is stored in the clear next to data, so it must not be a
    // piece of any key that protects that data.
    const fingerprint = keyFingerprint(master);
    const keys = deriveSubkeys(master);
    for (const subkey of [keys.fieldEncryption, keys.searchToken, keys.apiKey, keys.contentHash]) {
      expect(subkey.toString("hex")).not.toContain(fingerprint);
    }
  });

  it("rejects a master key that is too short", () => {
    expect(() => keyFingerprint("short")).toThrow(/at least 32/i);
  });
});
