import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

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
    throw new Error("Encrypted value is malformed.");
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
