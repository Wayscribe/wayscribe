import { describe, expect, it } from "vitest";
import { deriveSubkeys } from "./keys.js";

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
