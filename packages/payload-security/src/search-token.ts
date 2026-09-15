import { createHmac } from "node:crypto";
import type { Keyring } from "./keyring.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a value before hashing.
 *
 * Deliberately conservative: whitespace trimming and UUID case folding only.
 * External systems issue case-sensitive identifiers — a Salesforce ID is not
 * equal to its lowercase form — so blanket lowercasing would merge distinct
 * entities into one journey.
 */
export function normalizeSearchValue(value: string): string {
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * Deterministic search token for an alias or entity identifier.
 *
 * The token covers the value alone, never the alias type (ADR-028). A developer
 * typing an identifier into a search box does not know which alias type it was
 * stored under, so a type-dependent token would make the product's primary
 * lookup impossible and leave the documented value-only index unusable.
 *
 * Two alias types carrying the same value therefore hash identically, which is
 * correct for "find anything matching this value"; the plaintext `alias_type`
 * column disambiguates results at read time.
 *
 * HMAC rather than a bare hash, so a database leak alone does not let an
 * attacker confirm guessed values offline — these identifiers are often
 * low-entropy.
 */
export function searchToken(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(normalizeSearchValue(value), "utf8").digest("hex");
}

/**
 * Every token a stored value may carry: the current key's first, then the
 * previous key's during a rotation.
 *
 * Ingestion writes the first alone. A lookup matches against all of them, so a
 * record written under the old key stays findable until it is re-encrypted.
 */
export function searchTokens(keyring: Keyring, value: string): string[] {
  const tokens = [searchToken(keyring.current.searchToken, value)];
  if (keyring.previous !== null) tokens.push(searchToken(keyring.previous.searchToken, value));
  return tokens;
}
