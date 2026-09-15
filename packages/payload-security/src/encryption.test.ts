import { describe, expect, it } from "vitest";
import {
  decryptField,
  decryptValue,
  encryptField,
  encryptValue,
  keyIdOf,
  parseEncryptedValue
} from "./encryption.js";
import { createKeyring, UnknownKeyError } from "./keyring.js";
import { deriveSubkeys, keyFingerprint } from "./keys.js";

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

const masterA = "0123456789abcdef0123456789abcdef";
const masterB = "fedcba9876543210fedcba9876543210";
const masterC = "00000000000000000000000000000000";
const idA = keyFingerprint(masterA);
const idB = keyFingerprint(masterB);
const idC = keyFingerprint(masterC);

/** The error a call throws, so a test can assert what kind it is. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw.");
}

/**
 * The two ways decryption genuinely fails: the value's shape, or GCM
 * authentication (Node's message for a tag that does not verify). Matching the
 * message keeps an unrelated TypeError from passing as a decryption failure.
 */
const DECRYPTION_FAILURE =
  /^(Encrypted value is malformed\.|Unsupported state or unable to authenticate data)$/;

/** A decryption failure that is not an unknown key. */
function expectDecryptionError(call: () => unknown): void {
  const error = thrownBy(call);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(UnknownKeyError);
  expect((error as Error).message).toMatch(DECRYPTION_FAILURE);
}

function flipLastByte(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  const last = bytes.length - 1;
  bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last);
  return bytes.toString("base64");
}

describe("encryptValue", () => {
  it("writes an fr1 envelope under the current key", () => {
    const keyring = createKeyring(masterB, masterA);
    const value = encryptValue(keyring, "0018Z00002ABC");
    const [prefix, id, payload, ...rest] = value.split(".");
    expect(prefix).toBe("fr1");
    expect(id).toBe(idB);
    expect(rest).toEqual([]);
    // The payload keeps the legacy layout, so the envelope adds identity and
    // nothing else.
    expect(decryptField(keyring.current.fieldEncryption, payload ?? "")).toBe("0018Z00002ABC");
  });

  it("produces different ciphertext each time for the same plaintext", () => {
    const keyring = createKeyring(masterA);
    expect(encryptValue(keyring, "same")).not.toBe(encryptValue(keyring, "same"));
  });
});

describe("decryptValue", () => {
  it("round-trips a value, including unicode and empty strings", () => {
    const keyring = createKeyring(masterA);
    for (const plaintext of ["0018Z00002ABC", "café ☕", ""]) {
      expect(decryptValue(keyring, encryptValue(keyring, plaintext))).toBe(plaintext);
    }
  });

  it("decrypts an envelope written under the previous key", () => {
    const written = encryptValue(createKeyring(masterA), "secret");
    expect(decryptValue(createKeyring(masterB, masterA), written)).toBe("secret");
  });

  it("throws UnknownKeyError naming the id when the envelope's key is not in the keyring", () => {
    // The operator removed the previous key too early. This must be
    // distinguishable from corruption.
    const written = encryptValue(createKeyring(masterA), "secret");
    const error = thrownBy(() => decryptValue(createKeyring(masterB), written));
    expect(error).toBeInstanceOf(UnknownKeyError);
    expect((error as UnknownKeyError).keyId).toBe(idA);
    expect((error as UnknownKeyError).message).toContain(idA);
  });

  it("decrypts a legacy value under the current key", () => {
    const legacy = encryptField(deriveSubkeys(masterA).fieldEncryption, "secret");
    expect(decryptValue(createKeyring(masterA), legacy)).toBe("secret");
    expect(decryptValue(createKeyring(masterA, masterB), legacy)).toBe("secret");
  });

  it("decrypts a legacy value under the previous key", () => {
    const legacy = encryptField(deriveSubkeys(masterA).fieldEncryption, "secret");
    expect(decryptValue(createKeyring(masterB, masterA), legacy)).toBe("secret");
  });

  it("fails a legacy value that neither key decrypts with an ordinary decryption error", () => {
    const legacy = encryptField(deriveSubkeys(masterC).fieldEncryption, "secret");
    expectDecryptionError(() => decryptValue(createKeyring(masterB, masterA), legacy));
    expectDecryptionError(() => decryptValue(createKeyring(masterB), legacy));
  });

  it("fails a tampered envelope", () => {
    const keyring = createKeyring(masterA);
    const [, id, payload] = encryptValue(keyring, "secret").split(".");
    expectDecryptionError(() =>
      decryptValue(keyring, `fr1.${id ?? ""}.${flipLastByte(payload ?? "")}`)
    );
  });

  it("fails a tampered legacy value", () => {
    const keyring = createKeyring(masterB, masterA);
    const legacy = encryptField(keyring.previous?.fieldEncryption ?? Buffer.alloc(32), "secret");
    expectDecryptionError(() => decryptValue(keyring, flipLastByte(legacy)));
  });

  it("fails an envelope relabelled with the other key's id", () => {
    // Authentication, not the label, decides whether a key is right.
    const keyring = createKeyring(masterB, masterA);
    const [, , payload] = encryptValue(createKeyring(masterA), "secret").split(".");
    expectDecryptionError(() => decryptValue(keyring, `fr1.${idB}.${payload ?? ""}`));
  });

  it("treats a malformed envelope as a decryption error, not an unknown key", () => {
    const keyring = createKeyring(masterA);
    const [, , payload = ""] = encryptValue(keyring, "secret").split(".");
    const malformed = [
      "fr1.",
      "fr1..",
      `fr1.${idA}`,
      `fr1.${idA}.`,
      `fr1..${payload}`,
      `fr1.${idA}.${payload}.extra`,
      `fr1.${idA.slice(0, 11)}.${payload}`,
      `fr1.${idA}0.${payload}`,
      `fr1.zzzzzzzzzzzz.${payload}`,
      `fr1.${idA.toUpperCase().replace(/^[0-9]/, "A")}.${payload}`
    ];
    for (const value of malformed) {
      expectDecryptionError(() => decryptValue(keyring, value));
    }
  });

  it("rejects empty and non-base64 input", () => {
    const keyring = createKeyring(masterA);
    expectDecryptionError(() => decryptValue(keyring, ""));
    expectDecryptionError(() => decryptValue(keyring, "not-base64-at-all!!"));
  });
});

describe("parseEncryptedValue", () => {
  const payload = encryptField(key, "secret");

  it("calls a value without the prefix legacy", () => {
    expect(parseEncryptedValue(payload)).toEqual({ kind: "legacy" });
    expect(parseEncryptedValue("")).toEqual({ kind: "legacy" });
  });

  it("splits an envelope into its key id and payload", () => {
    expect(parseEncryptedValue(`fr1.${idA}.${payload}`)).toEqual({
      kind: "envelope",
      keyId: idA,
      payload
    });
  });

  it("parses what encryptValue writes", () => {
    const parsed = parseEncryptedValue(encryptValue(createKeyring(masterB, masterA), "secret"));
    expect(parsed.kind === "envelope" && parsed.keyId).toBe(idB);
  });

  it("reports a malformed envelope without throwing", () => {
    // Re-encryption and status count these rows as unrecoverable. A throw inside
    // a batch would abort it, and every resume would stop on the same row.
    const malformed = [
      "fr1.",
      "fr1..",
      `fr1.${idA}`,
      `fr1.${idA}.`,
      `fr1..${payload}`,
      `fr1.${idA}.${payload}.extra`,
      `fr1.${idA}..${payload}`,
      `fr1.${idA.slice(0, 11)}.${payload}`,
      `fr1.${idA}0.${payload}`,
      `fr1.zzzzzzzzzzzz.${payload}`,
      "fr1.ABCDEF012345." + payload
    ];
    for (const value of malformed) {
      expect(parseEncryptedValue(value)).toEqual({ kind: "malformed" });
    }
  });
});

describe("keyIdOf", () => {
  it("returns the key id of an envelope", () => {
    expect(keyIdOf(encryptValue(createKeyring(masterC), "secret"))).toBe(idC);
  });

  it("returns null for a legacy value", () => {
    expect(keyIdOf(encryptField(key, "secret"))).toBeNull();
  });

  it("throws for a malformed envelope rather than calling it legacy", () => {
    expectDecryptionError(() => keyIdOf("fr1.nothex.payload"));
    expectDecryptionError(() => keyIdOf("fr1."));
  });
});
