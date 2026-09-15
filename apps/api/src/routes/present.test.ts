import { createKeyring, encryptValue } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { presentAliases, presentEntityId } from "./present.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const key = createKeyring(KEY_A);

describe("presentEntityId", () => {
  it("returns the entity id in full", () => {
    // The caller just searched for this value; returning it discloses nothing new.
    expect(presentEntityId(key, encryptValue(key, "0018Z00002ABC"))).toBe("0018Z00002ABC");
  });

  it("reads a value written under the previous key during a rotation", () => {
    const written = encryptValue(key, "0018Z00002ABC");
    expect(presentEntityId(createKeyring(KEY_B, KEY_A), written)).toBe("0018Z00002ABC");
  });

  it("returns null for a value under a key that is no longer configured", () => {
    // UnknownKeyError, not the ordinary failure, but a read still degrades one
    // field rather than failing the request.
    const written = encryptValue(key, "0018Z00002ABC");
    expect(presentEntityId(createKeyring(KEY_B), written)).toBeNull();
  });

  it("reports the missing key's id, and only for a missing key", () => {
    const met: string[] = [];
    const written = encryptValue(key, "0018Z00002ABC");
    expect(presentEntityId(createKeyring(KEY_B), written, (keyId) => met.push(keyId))).toBeNull();
    expect(presentEntityId(key, "not-real-ciphertext", (keyId) => met.push(keyId))).toBeNull();
    expect(met).toEqual([key.current.id]);
  });

  it("returns null when nothing was stored", () => {
    expect(presentEntityId(key, null)).toBeNull();
  });

  it("returns null rather than throwing on undecryptable data", () => {
    expect(presentEntityId(key, "not-real-ciphertext")).toBeNull();
  });
});

describe("presentAliases", () => {
  it("masks alias display values", () => {
    const result = presentAliases(key, [
      {
        aliasType: "salesforceAccountId",
        encryptedDisplayValue: encryptValue(key, "SF-ALIAS-99001")
      }
    ]);
    expect(result).toEqual([{ type: "salesforceAccountId", displayValue: "SF-A…001" }]);
  });

  it("masks an alias written under the previous key during a rotation", () => {
    const result = presentAliases(createKeyring(KEY_B, KEY_A), [
      {
        aliasType: "salesforceAccountId",
        encryptedDisplayValue: encryptValue(key, "SF-ALIAS-99001")
      }
    ]);
    expect(result).toEqual([{ type: "salesforceAccountId", displayValue: "SF-A…001" }]);
  });

  it("reports the missing key's id for an alias under a removed key", () => {
    const met: string[] = [];
    const result = presentAliases(
      createKeyring(KEY_B),
      [{ aliasType: "salesforceAccountId", encryptedDisplayValue: encryptValue(key, "SF-1") }],
      (keyId) => met.push(keyId)
    );
    expect(result).toEqual([{ type: "salesforceAccountId", displayValue: null }]);
    expect(met).toEqual([key.current.id]);
  });

  it("fully masks short values", () => {
    const result = presentAliases(key, [
      { aliasType: "shortId", encryptedDisplayValue: encryptValue(key, "12345") }
    ]);
    expect(result[0]?.displayValue).toBe("…");
  });

  it("returns a null display value when nothing was stored", () => {
    const result = presentAliases(key, [{ aliasType: "t", encryptedDisplayValue: null }]);
    expect(result[0]?.displayValue).toBeNull();
  });
});
