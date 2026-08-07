import { createHmac } from "node:crypto";

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
 * The alias type is part of the HMAC input (DATABASE_SCHEMA.md section 4), so
 * the same value under two alias types yields different tokens and cannot
 * collide. HMAC rather than a bare hash, so a database leak alone does not let
 * an attacker confirm guessed values offline — these identifiers are often
 * low-entropy.
 */
export function searchToken(key: Buffer, aliasType: string, value: string): string {
  return createHmac("sha256", key)
    .update(`${aliasType}:${normalizeSearchValue(value)}`, "utf8")
    .digest("hex");
}
