import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Keyring } from "./keyring.js";

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

export interface StoredApiKey {
  /** Stored for lookup and safe display. */
  keyPrefix: string;
  /** Stored verifier. */
  verifier: string;
}

/**
 * The stored form of a key the caller already holds.
 *
 * `issueApiKey` is the entry point everywhere a key is issued to a person:
 * it supplies the entropy, which a caller-chosen key does not. This exists for
 * the demo, whose services need a key fixed in advance because there is nobody
 * to read one off a terminal.
 */
export function apiKeyRecord(pepper: Buffer, apiKey: string): StoredApiKey {
  return {
    keyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH),
    verifier: computeVerifier(pepper, apiKey)
  };
}

/**
 * A new key: `wsk_` and 32 base64url characters, 36 in all.
 *
 * Keys issued before the rename (ADR-057) start `fr_` and are 35 characters.
 * They still verify: the server looks a key up by its first 12 characters and
 * verifies an HMAC of the whole key, so it never checks which prefix a key has.
 */
export function generateApiKey(pepper: Buffer): GeneratedApiKey {
  const apiKey = `wsk_${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { apiKey, ...apiKeyRecord(pepper, apiKey) };
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

export interface IssuedApiKey extends GeneratedApiKey {
  /** Id of the key whose pepper produced `verifier`. */
  keyHashKeyId: string;
}

export interface IssuedApiKeyRecord extends StoredApiKey {
  /** Id of the key whose pepper produced `verifier`. */
  keyHashKeyId: string;
}

/** A stored verifier, in the shape of its `api_keys` columns. */
export interface ApiKeyVerifier {
  keyHash: string;
  /** Null for a verifier written before verifiers recorded their key. */
  keyHashKeyId: string | null;
}

export type ApiKeyVerification =
  | { ok: false }
  | {
      ok: true;
      /** The verifier to store in place of the old one, or null when it is current. */
      migrate: { keyHash: string; keyHashKeyId: string } | null;
    };

/** `generateApiKey` under the keyring's current pepper, labelled with its id. */
export function issueApiKey(keyring: Keyring): IssuedApiKey {
  return { ...generateApiKey(keyring.current.apiKey), keyHashKeyId: keyring.current.id };
}

/** `apiKeyRecord` under the keyring's current pepper, labelled with its id. */
export function apiKeyRecordFor(keyring: Keyring, apiKey: string): IssuedApiKeyRecord {
  return { ...apiKeyRecord(keyring.current.apiKey, apiKey), keyHashKeyId: keyring.current.id };
}

/**
 * Verify a presented key against a verifier that may predate a rotation.
 *
 * An HMAC verifier cannot be re-encrypted: moving it to a new pepper needs the
 * plaintext key, and the only time the server holds that is when a client
 * presents it. So a key verified under the previous pepper comes back with the
 * verifier to store under the current one. A key verified under current whose
 * row has no key id, or a wrong one, comes back with that id, so rotation status
 * is accurate on an install that predates key ids.
 *
 * The order follows the stored label: a row labelled with the previous id is
 * checked under previous only, any other row under current, and only an
 * unlabelled row falls back to previous. Every comparison is `verifyApiKey`'s
 * constant-time one, and every failure is the same `{ ok: false }`.
 */
export function verifyApiKeyWithKeyring(
  keyring: Keyring,
  presented: string,
  stored: ApiKeyVerifier
): ApiKeyVerification {
  const { current, previous } = keyring;
  const migrated = (): { keyHash: string; keyHashKeyId: string } => ({
    keyHash: computeVerifier(current.apiKey, presented),
    keyHashKeyId: current.id
  });

  if (previous !== null && stored.keyHashKeyId === previous.id) {
    return verifyApiKey(previous.apiKey, presented, stored.keyHash)
      ? { ok: true, migrate: migrated() }
      : { ok: false };
  }

  if (verifyApiKey(current.apiKey, presented, stored.keyHash)) {
    // A label other than current's is either missing (written before labels) or
    // wrong; either way the verifier is current, so recording the id repairs it.
    return { ok: true, migrate: stored.keyHashKeyId === current.id ? null : migrated() };
  }

  if (
    previous !== null &&
    stored.keyHashKeyId === null &&
    verifyApiKey(previous.apiKey, presented, stored.keyHash)
  ) {
    return { ok: true, migrate: migrated() };
  }

  return { ok: false };
}

function computeVerifier(pepper: Buffer, apiKey: string): string {
  return createHmac("sha256", pepper).update(apiKey, "utf8").digest("hex");
}
