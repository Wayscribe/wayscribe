import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveSubkeys, keyFingerprint } from "./keys.js";

/**
 * These HKDF labels decide every derived key. Renaming one makes stored
 * ciphertext unreadable, search tokens stop matching and stored API key
 * verifiers fail, so the product rename (ADR-057) left them as written.
 */
const LABELS: Record<string, string[]> = {
  "packages/payload-security/src/keys.ts": [
    "flight-recorder/field-encryption",
    "flight-recorder/search-token",
    "flight-recorder/api-key",
    "flight-recorder/content-hash",
    "flight-recorder/key-id"
  ],
  "apps/web/src/lib/session.ts": ["flight-recorder/web-session"]
};

const master = "0123456789abcdef0123456789abcdef";

const expected = (info: string, length = 32): Buffer =>
  Buffer.from(hkdfSync("sha256", master, "", info, length));

describe("key-derivation labels", () => {
  for (const [file, labels] of Object.entries(LABELS)) {
    it(`${file} still derives with its original labels`, () => {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      for (const label of labels) expect(source, label).toContain(`"${label}"`);
    });
  }

  it("derives each subkey from its original label", () => {
    const keys = deriveSubkeys(master);
    expect(keys.fieldEncryption.equals(expected("flight-recorder/field-encryption"))).toBe(true);
    expect(keys.searchToken.equals(expected("flight-recorder/search-token"))).toBe(true);
    expect(keys.apiKey.equals(expected("flight-recorder/api-key"))).toBe(true);
    expect(keys.contentHash.equals(expected("flight-recorder/content-hash"))).toBe(true);
  });

  it("derives the key fingerprint from its original label", () => {
    expect(keyFingerprint(master)).toBe(expected("flight-recorder/key-id", 6).toString("hex"));
  });
});
