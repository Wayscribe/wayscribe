import { hkdfSync } from "node:crypto";

export interface Subkeys {
  fieldEncryption: Buffer;
  searchToken: Buffer;
  apiKey: Buffer;
}

const SUBKEY_LENGTH = 32;
const MINIMUM_MASTER_LENGTH = 32;

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
  if (masterKey.length < MINIMUM_MASTER_LENGTH) {
    throw new Error(`Master key must be at least ${String(MINIMUM_MASTER_LENGTH)} characters.`);
  }

  return {
    fieldEncryption: derive(masterKey, "flight-recorder/field-encryption"),
    searchToken: derive(masterKey, "flight-recorder/search-token"),
    apiKey: derive(masterKey, "flight-recorder/api-key")
  };
}

function derive(masterKey: string, info: string): Buffer {
  // An empty salt is acceptable here: the info label provides domain separation
  // and the master key is already high-entropy.
  return Buffer.from(hkdfSync("sha256", masterKey, "", info, SUBKEY_LENGTH));
}
