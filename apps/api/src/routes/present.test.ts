import { deriveSubkeys, encryptField } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { presentAliases, presentEntityId } from "./present.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");
const key = subkeys.fieldEncryption;

describe("presentEntityId", () => {
  it("returns the entity id in full", () => {
    // The caller just searched for this value; returning it discloses nothing new.
    expect(presentEntityId(key, encryptField(key, "0018Z00002ABC"))).toBe("0018Z00002ABC");
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
        encryptedDisplayValue: encryptField(key, "SF-ALIAS-99001")
      }
    ]);
    expect(result).toEqual([{ type: "salesforceAccountId", displayValue: "SF-A…001" }]);
  });

  it("fully masks short values", () => {
    const result = presentAliases(key, [
      { aliasType: "shortId", encryptedDisplayValue: encryptField(key, "12345") }
    ]);
    expect(result[0]?.displayValue).toBe("…");
  });

  it("returns a null display value when nothing was stored", () => {
    const result = presentAliases(key, [{ aliasType: "t", encryptedDisplayValue: null }]);
    expect(result[0]?.displayValue).toBeNull();
  });
});
