import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX_LENGTH,
  apiKeyRecord,
  apiKeyRecordFor,
  generateApiKey,
  issueApiKey,
  verifyApiKey,
  verifyApiKeyWithKeyring
} from "./api-key.js";
import { createKeyring } from "./keyring.js";
import { deriveSubkeys, keyFingerprint } from "./keys.js";

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

const masterA = "0123456789abcdef0123456789abcdef";
const masterB = "fedcba9876543210fedcba9876543210";
const masterC = "00000000000000000000000000000000";

describe("issueApiKey", () => {
  it("issues a key verified under the current pepper and records the current key id", () => {
    const keyring = createKeyring(masterB, masterA);
    const issued = issueApiKey(keyring);
    expect(issued.apiKey.startsWith("fr_")).toBe(true);
    expect(issued.keyPrefix).toBe(issued.apiKey.slice(0, API_KEY_PREFIX_LENGTH));
    expect(issued.keyHashKeyId).toBe(keyFingerprint(masterB));
    expect(verifyApiKey(keyring.current.apiKey, issued.apiKey, issued.verifier)).toBe(true);
  });

  it("never repeats a key", () => {
    const keyring = createKeyring(masterA);
    const keys = new Set(Array.from({ length: 200 }, () => issueApiKey(keyring).apiKey));
    expect(keys.size).toBe(200);
  });
});

describe("apiKeyRecordFor", () => {
  const demoKey = "fr_demo00000000000000000000000000000";

  it("matches the single-pepper record under the current key and records its id", () => {
    const keyring = createKeyring(masterB, masterA);
    expect(apiKeyRecordFor(keyring, demoKey)).toEqual({
      ...apiKeyRecord(deriveSubkeys(masterB).apiKey, demoKey),
      keyHashKeyId: keyFingerprint(masterB)
    });
  });
});

describe("verifyApiKeyWithKeyring", () => {
  const presented = "fr_verify0000000000000000000000000000";
  const wrong = "fr_wrong00000000000000000000000000000";
  const idA = keyFingerprint(masterA);
  const idB = keyFingerprint(masterB);
  const hashUnder = (master: string, apiKey = presented): string =>
    apiKeyRecord(deriveSubkeys(master).apiKey, apiKey).verifier;
  const migratedToB = { keyHash: hashUnder(masterB), keyHashKeyId: idB };

  describe("with no previous key", () => {
    const keyring = createKeyring(masterB);

    it("accepts a key stored under the current id without migrating", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: idB
        })
      ).toEqual({ ok: true, migrate: null });
    });

    it("accepts a key with a null id under current and records the current id", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: null
        })
      ).toEqual({ ok: true, migrate: migratedToB });
    });

    it("rejects a key stored under a removed key", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterA),
          keyHashKeyId: idA
        })
      ).toEqual({ ok: false });
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterA),
          keyHashKeyId: null
        })
      ).toEqual({ ok: false });
    });
  });

  describe("with a previous key", () => {
    const keyring = createKeyring(masterB, masterA);

    it("verifies a key stored under the previous id with the previous pepper and migrates it", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterA),
          keyHashKeyId: idA
        })
      ).toEqual({ ok: true, migrate: migratedToB });
    });

    it("does not fall back to current for a key labelled with the previous id", () => {
      // Step 1 of the order is exclusive: the label says which pepper applies.
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: idA
        })
      ).toEqual({ ok: false });
    });

    it("accepts a key stored under the current id without migrating", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: idB
        })
      ).toEqual({ ok: true, migrate: null });
    });

    it("accepts a null-id key under current and records the current id", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: null
        })
      ).toEqual({ ok: true, migrate: migratedToB });
    });

    it("falls back to previous for a null-id key and migrates it", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterA),
          keyHashKeyId: null
        })
      ).toEqual({ ok: true, migrate: migratedToB });
    });

    it("does not fall back to previous for a key labelled with the current id", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterA),
          keyHashKeyId: idB
        })
      ).toEqual({ ok: false });
    });

    it("rejects a wrong key under both peppers", () => {
      for (const stored of [
        { keyHash: hashUnder(masterB), keyHashKeyId: idB },
        { keyHash: hashUnder(masterA), keyHashKeyId: idA },
        { keyHash: hashUnder(masterB), keyHashKeyId: null },
        { keyHash: hashUnder(masterA), keyHashKeyId: null }
      ]) {
        expect(verifyApiKeyWithKeyring(keyring, wrong, stored)).toEqual({ ok: false });
      }
    });

    it("rejects a key stored under a key in neither slot", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterC),
          keyHashKeyId: keyFingerprint(masterC)
        })
      ).toEqual({ ok: false });
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterC),
          keyHashKeyId: null
        })
      ).toEqual({ ok: false });
    });

    it("repairs a label in neither slot when the key verifies under current", () => {
      // The label is wrong but the verifier is current; rewriting the label costs
      // nothing and keeps rotation status accurate.
      expect(
        verifyApiKeyWithKeyring(keyring, presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: keyFingerprint(masterC)
        })
      ).toEqual({ ok: true, migrate: migratedToB });
      expect(
        verifyApiKeyWithKeyring(createKeyring(masterB), presented, {
          keyHash: hashUnder(masterB),
          keyHashKeyId: keyFingerprint(masterC)
        })
      ).toEqual({ ok: true, migrate: migratedToB });
    });

    it("rejects a malformed stored hash without throwing", () => {
      expect(
        verifyApiKeyWithKeyring(keyring, presented, { keyHash: "zzzz", keyHashKeyId: null })
      ).toEqual({ ok: false });
    });
  });
});
