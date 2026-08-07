import { describe, expect, it } from "vitest";
import { decryptField, encryptField } from "./encryption.js";
import { deriveSubkeys } from "./keys.js";

const key = deriveSubkeys("0123456789abcdef0123456789abcdef").fieldEncryption;

describe("field encryption", () => {
  it("round-trips a value", () => {
    expect(decryptField(key, encryptField(key, "0018Z00002ABC"))).toBe("0018Z00002ABC");
  });

  it("round-trips unicode and empty strings", () => {
    expect(decryptField(key, encryptField(key, "café ☕"))).toBe("café ☕");
    expect(decryptField(key, encryptField(key, ""))).toBe("");
  });

  it("produces different ciphertext each time for the same plaintext", () => {
    // A fresh IV per encryption. Equal ciphertexts would leak equality of
    // plaintexts across rows, which for entity IDs is most of the secret.
    expect(encryptField(key, "same")).not.toBe(encryptField(key, "same"));
  });

  it("fails to decrypt with a different key", () => {
    const other = deriveSubkeys("fedcba9876543210fedcba9876543210").fieldEncryption;
    expect(() => decryptField(other, encryptField(key, "secret"))).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const encrypted = encryptField(key, "secret");
    const bytes = Buffer.from(encrypted, "base64");
    const last = bytes.length - 1;
    bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last);
    expect(() => decryptField(key, bytes.toString("base64"))).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => decryptField(key, "not-base64-at-all!!")).toThrow();
    expect(() => decryptField(key, "")).toThrow();
  });
});
