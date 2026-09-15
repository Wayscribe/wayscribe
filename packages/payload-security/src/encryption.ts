import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { keyMaterialFor, UnknownKeyError, type Keyring } from "./keyring.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MALFORMED = "Encrypted value is malformed.";

/**
 * Encrypt a single field value.
 *
 * Layout is base64 of `iv || authTag || ciphertext`, so one text column holds
 * everything needed to decrypt. A fresh random IV per call is essential: GCM
 * catastrophically loses confidentiality if an IV is reused under the same key.
 */
export function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptField(key: Buffer, encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(MALFORMED);
  }

  const iv = bytes.subarray(0, IV_LENGTH);
  const authTag = bytes.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // final() throws when the tag does not verify, which is how tampering and wrong
  // keys surface. Never catch this and return partial plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const ENVELOPE_PREFIX = "fr1.";
const KEY_ID_PATTERN = /^[0-9a-f]{12}$/;

export type ParsedEncryptedValue =
  { kind: "legacy" } | { kind: "envelope"; keyId: string; payload: string } | { kind: "malformed" };

/**
 * Encrypt under the keyring's current key, labelled with that key's id.
 *
 * The layout is `fr1.<keyId>.<base64(iv || authTag || ciphertext)>`. The payload
 * is exactly what `encryptField` produces; the label is what lets a rotation read
 * old values under the old key and find the rows that still need rewriting.
 */
export function encryptValue(keyring: Keyring, plaintext: string): string {
  const { current } = keyring;
  return `${ENVELOPE_PREFIX}${current.id}.${encryptField(current.fieldEncryption, plaintext)}`;
}

/**
 * Decrypt a value written by `encryptValue`, or a legacy value written before
 * values carried a key id.
 *
 * A labelled value is decrypted under the key it names, and names a key the
 * keyring lacks only when that key was removed. A legacy value names nothing, so
 * both keys are tried; GCM authentication makes the wrong one fail rather than
 * produce garbage. When neither works the value is unreadable, which is reported
 * as the ordinary decryption failure: there is no id to blame.
 */
export function decryptValue(keyring: Keyring, value: string): string {
  const parsed = parseEncryptedValue(value);
  if (parsed.kind === "malformed") throw new Error(MALFORMED);
  if (parsed.kind === "envelope") {
    const material = keyMaterialFor(keyring, parsed.keyId);
    if (material === null) throw new UnknownKeyError(parsed.keyId);
    return decryptField(material.fieldEncryption, parsed.payload);
  }

  try {
    return decryptField(keyring.current.fieldEncryption, value);
  } catch (error) {
    if (keyring.previous === null) throw error;
    try {
      return decryptField(keyring.previous.fieldEncryption, value);
    } catch {
      throw error;
    }
  }
}

/**
 * The key id a value was written under, or null for a legacy value.
 *
 * A malformed envelope throws rather than returning null: calling it legacy
 * would send it down a path that tries both keys and reports a misleading cause.
 * Code that must keep going past a bad row uses `parseEncryptedValue` instead.
 */
export function keyIdOf(value: string): string | null {
  const parsed = parseEncryptedValue(value);
  if (parsed.kind === "malformed") throw new Error(MALFORMED);
  return parsed.kind === "envelope" ? parsed.keyId : null;
}

/**
 * Classify a stored value without decrypting it or throwing.
 *
 * Re-encryption and status walk every row and count a malformed one as
 * unrecoverable. A throw there would abort the batch, and every resume would
 * stop on the same row, so the malformed case is a result rather than an error.
 */
export function parseEncryptedValue(value: string): ParsedEncryptedValue {
  // Standard base64 never contains ".", so no legacy value starts with the prefix.
  if (!value.startsWith(ENVELOPE_PREFIX)) return { kind: "legacy" };

  const parts = value.slice(ENVELOPE_PREFIX.length).split(".");
  const [keyId, payload] = parts;
  if (
    parts.length !== 2 ||
    keyId === undefined ||
    payload === undefined ||
    !KEY_ID_PATTERN.test(keyId) ||
    payload.length === 0
  ) {
    return { kind: "malformed" };
  }
  return { kind: "envelope", keyId, payload };
}
