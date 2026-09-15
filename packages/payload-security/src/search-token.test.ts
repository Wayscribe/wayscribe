import { describe, expect, it } from "vitest";
import { createKeyring } from "./keyring.js";
import { deriveSubkeys } from "./keys.js";
import { normalizeSearchValue, searchToken, searchTokens } from "./search-token.js";

const key = deriveSubkeys("0123456789abcdef0123456789abcdef").searchToken;

describe("normalizeSearchValue", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeSearchValue("  18492  ")).toBe("18492");
  });

  it("lowercases UUIDs", () => {
    expect(normalizeSearchValue("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  it("preserves case in non-UUID identifiers", () => {
    // Salesforce IDs are case-sensitive. Lowercasing them would merge distinct records.
    expect(normalizeSearchValue("0018Z00002ABC")).toBe("0018Z00002ABC");
  });

  it("preserves punctuation", () => {
    expect(normalizeSearchValue("CUST-8841")).toBe("CUST-8841");
  });
});

describe("searchToken", () => {
  it("is deterministic", () => {
    expect(searchToken(key, "18492")).toBe(searchToken(key, "18492"));
  });

  it("normalizes before hashing", () => {
    expect(searchToken(key, " 18492 ")).toBe(searchToken(key, "18492"));
  });

  // Type-independence (ADR-028) is now enforced by the signature — there is no
  // type parameter to pass — so a unit test here could only assert that a value
  // equals itself. The property that matters is that two aliases of different
  // types sharing a value are both found by one value-only search, which is
  // covered in the search integration tests.

  it("differs across keys", () => {
    const other = deriveSubkeys("fedcba9876543210fedcba9876543210").searchToken;
    expect(searchToken(key, "18492")).not.toBe(searchToken(other, "18492"));
  });

  it("returns lowercase hex of fixed length", () => {
    expect(searchToken(key, "v")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("searchTokens", () => {
  const masterA = "0123456789abcdef0123456789abcdef";
  const masterB = "fedcba9876543210fedcba9876543210";

  it("returns the current key's token alone when there is no previous key", () => {
    const keyring = createKeyring(masterA);
    expect(searchTokens(keyring, "18492")).toEqual([
      searchToken(keyring.current.searchToken, "18492")
    ]);
  });

  it("returns the current key's token first and the previous key's second", () => {
    const keyring = createKeyring(masterB, masterA);
    expect(searchTokens(keyring, "18492")).toEqual([
      searchToken(deriveSubkeys(masterB).searchToken, "18492"),
      searchToken(deriveSubkeys(masterA).searchToken, "18492")
    ]);
  });

  it("normalizes before hashing under both keys", () => {
    const keyring = createKeyring(masterB, masterA);
    expect(searchTokens(keyring, " 18492 ")).toEqual(searchTokens(keyring, "18492"));
  });
});
