import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 24;
export const API_KEY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** Full key. Shown to the user once and never stored. */
  apiKey: string;
  /** Stored for lookup and safe display. */
  keyPrefix: string;
  /** Stored verifier. */
  verifier: string;
}

export function generateApiKey(pepper: Buffer): GeneratedApiKey {
  const apiKey = `fr_${randomBytes(KEY_BYTES).toString("base64url")}`;
  return {
    apiKey,
    keyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH),
    verifier: computeVerifier(pepper, apiKey)
  };
}

/**
 * Constant-time verification.
 *
 * HMAC rather than a slow password hash: these keys carry 24 bytes of entropy,
 * so there is no guessing attack for a slow hash to frustrate, and this runs on
 * the ingestion hot path where 50-100ms per request would be self-inflicted
 * denial of service. The pepper means a database-only leak yields nothing an
 * attacker can verify offline.
 */
export function verifyApiKey(pepper: Buffer, presented: string, verifier: string): boolean {
  const expected = Buffer.from(computeVerifier(pepper, presented), "hex");
  const actual = Buffer.from(verifier, "hex");
  // timingSafeEqual throws on a length mismatch, so lengths are compared first.
  // This comparison is not secret-dependent.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function computeVerifier(pepper: Buffer, apiKey: string): string {
  return createHmac("sha256", pepper).update(apiKey, "utf8").digest("hex");
}
