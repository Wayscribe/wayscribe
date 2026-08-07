import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX_LENGTH, apiKeyRecord, generateApiKey, verifyApiKey } from "./api-key.js";
import { deriveSubkeys } from "./keys.js";

const key = deriveSubkeys("0123456789abcdef0123456789abcdef").apiKey;

describe("generateApiKey", () => {
  it("returns a key, a prefix, and a verifier", () => {
    const generated = generateApiKey(key);
    expect(generated.apiKey.startsWith("fr_")).toBe(true);
    expect(generated.keyPrefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(generated.apiKey.startsWith(generated.keyPrefix)).toBe(true);
    expect(generated.verifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey(key).apiKey));
    expect(keys.size).toBe(200);
  });

  it("does not store the key itself in the verifier", () => {
    const generated = generateApiKey(key);
    expect(generated.verifier).not.toContain(generated.apiKey.slice(3));
  });
});

describe("apiKeyRecord", () => {
  const demoKey = "fr_demo00000000000000000000000000000";

  it("produces a record that verifies the same key", () => {
    expect(verifyApiKey(key, demoKey, apiKeyRecord(key, demoKey).verifier)).toBe(true);
  });

  it("rejects a different key", () => {
    const other = "fr_other0000000000000000000000000000";
    expect(verifyApiKey(key, other, apiKeyRecord(key, demoKey).verifier)).toBe(false);
  });

  it("takes the prefix from the key itself", () => {
    expect(apiKeyRecord(key, demoKey).keyPrefix).toBe("fr_demo00000");
  });
});

describe("verifyApiKey", () => {
  it("accepts the correct key", () => {
    const generated = generateApiKey(key);
    expect(verifyApiKey(key, generated.apiKey, generated.verifier)).toBe(true);
  });

  it("rejects a different key", () => {
    const generated = generateApiKey(key);
    const other = generateApiKey(key);
    expect(verifyApiKey(key, other.apiKey, generated.verifier)).toBe(false);
  });

  it("rejects a key verified against a different pepper", () => {
    const generated = generateApiKey(key);
    const otherPepper = deriveSubkeys("fedcba9876543210fedcba9876543210").apiKey;
    expect(verifyApiKey(otherPepper, generated.apiKey, generated.verifier)).toBe(false);
  });

  it("rejects a malformed verifier without throwing", () => {
    const generated = generateApiKey(key);
    expect(verifyApiKey(key, generated.apiKey, "")).toBe(false);
    expect(verifyApiKey(key, generated.apiKey, "zzzz")).toBe(false);
  });
});
