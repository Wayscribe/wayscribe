import { hkdfSync } from "node:crypto";

export interface Subkeys {
  fieldEncryption: Buffer;
  searchToken: Buffer;
  apiKey: Buffer;
}

const SUBKEY_LENGTH = 32;
const MINIMUM_MASTER_LENGTH = 32;
const FINGERPRINT_LENGTH = 6;

/**
 * Derive purpose-separated subkeys from one master key.
 *
 * Three primitives need key material, and reusing a single key across
 * encryption, search tokens, and API-key verification is poor practice.
 * Requiring three environment variables works against the onboarding target, so
 * HKDF splits one configured value into three cryptographically independent
 * keys.
 *
 * Rotating the master rotates all three, which invalidates existing search
 * tokens and API keys. V0 accepts that; see the Phase 1a design.
 */
export function deriveSubkeys(masterKey: string): Subkeys {
  assertMasterLength(masterKey);

  return {
    fieldEncryption: derive(masterKey, "flight-recorder/field-encryption"),
    searchToken: derive(masterKey, "flight-recorder/search-token"),
    apiKey: derive(masterKey, "flight-recorder/api-key")
  };
}

/**
 * The identifier stored beside everything written under a master key.
 *
 * Derived rather than configured, so an operator cannot mislabel a key. A
 * distinct HKDF info label makes it independent of the three subkeys, so storing
 * it in the clear next to ciphertext reveals nothing about the keys protecting
 * that ciphertext. Six bytes is ample to tell two keys of one install apart;
 * this is a label, not an authenticator.
 */
export function keyFingerprint(masterKey: string): string {
  assertMasterLength(masterKey);
  return derive(masterKey, "flight-recorder/key-id", FINGERPRINT_LENGTH).toString("hex");
}

function assertMasterLength(masterKey: string): void {
  if (masterKey.length < MINIMUM_MASTER_LENGTH) {
    throw new Error(`Master key must be at least ${String(MINIMUM_MASTER_LENGTH)} characters.`);
  }
}

function derive(masterKey: string, info: string, length = SUBKEY_LENGTH): Buffer {
  // An empty salt is acceptable here: the info label provides domain separation
  // and the master key is already high-entropy.
  return Buffer.from(hkdfSync("sha256", masterKey, "", info, length));
}
