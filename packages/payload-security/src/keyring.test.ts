import { describe, expect, it } from "vitest";
import { createKeyring, UnknownKeyError } from "./keyring.js";
import { deriveSubkeys, keyFingerprint } from "./keys.js";

const keyA = "0123456789abcdef0123456789abcdef";
const keyB = "fedcba9876543210fedcba9876543210";

describe("createKeyring", () => {
  it("holds the current key's id and subkeys", () => {
    const keyring = createKeyring(keyA);
    const subkeys = deriveSubkeys(keyA);
    expect(keyring.current.id).toBe(keyFingerprint(keyA));
    expect(keyring.current.fieldEncryption.equals(subkeys.fieldEncryption)).toBe(true);
    expect(keyring.current.searchToken.equals(subkeys.searchToken)).toBe(true);
    expect(keyring.current.apiKey.equals(subkeys.apiKey)).toBe(true);
    expect(keyring.previous).toBeNull();
  });

  it("holds a previous key when given one", () => {
    const keyring = createKeyring(keyB, keyA);
    expect(keyring.current.id).toBe(keyFingerprint(keyB));
    expect(keyring.previous?.id).toBe(keyFingerprint(keyA));
    expect(keyring.previous?.apiKey.equals(deriveSubkeys(keyA).apiKey)).toBe(true);
  });

  it("refuses a previous key identical to the current one", () => {
    // A copy-paste mistake would otherwise start a rotation that rotates nothing.
    expect(() => createKeyring(keyA, keyA)).toThrow(/same key/i);
  });

  it("rejects a current or previous key that is too short", () => {
    expect(() => createKeyring("short")).toThrow(/at least 32/i);
    expect(() => createKeyring(keyA, "short")).toThrow(/at least 32/i);
  });
});

describe("UnknownKeyError", () => {
  it("carries the key id and names it in the message", () => {
    const error = new UnknownKeyError("abcdef012345");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UnknownKeyError");
    expect(error.keyId).toBe("abcdef012345");
    expect(error.message).toContain("abcdef012345");
  });
});
