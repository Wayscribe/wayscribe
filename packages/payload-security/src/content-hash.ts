import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { keyMaterialFor, type Keyring } from "./keyring.js";

/** Marks a keyed hash, and says which derivation wrote it. */
const VERSION_PREFIX = "h1";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The content hash ingestion stores beside an event: `h1.<keyId>.<hex>`, an
 * HMAC-SHA256 of the canonical event under the content-hash subkey of the
 * current key.
 *
 * Object keys are sorted recursively, so two semantically identical events
 * serialized with different key order hash alike. Array order is preserved,
 * because it is meaningful.
 *
 * Ingestion computes this over the event *as received*, before redaction and
 * masking: ADR-021 exists to catch a client reusing an event ID for different
 * content, so hashing redacted output would let a server-side policy change
 * alter the hash of an unchanged input and manufacture conflicts.
 *
 * Keyed because the input is unmasked and the output is stored beside the
 * masked row. An unkeyed SHA-256 let anyone with a database read rebuild an
 * event from the row with a guess in place of `[REDACTED]` and confirm a
 * dictionary password offline, which the security review did (ADR-048). The key
 * id makes a hash written under the previous key comparable during a rotation,
 * as an encrypted value is.
 */
export function contentHash(keyring: Keyring, value: unknown): string {
  const { id, contentHash: subkey } = keyring.current;
  return `${VERSION_PREFIX}.${id}.${hmacHex(subkey, value)}`;
}

/**
 * Whether a stored content hash is the hash of `value`.
 *
 * A keyed hash is recomputed under the key it names, current or previous. A
 * value with no prefix is a hash written before hashes were keyed and is
 * compared by computing the unkeyed hash, so a resend that straddles the
 * upgrade still dedupes.
 *
 * A hash under a key the keyring no longer holds cannot be recomputed and does
 * not match. It cannot be rewritten either, since that needs the event, so a
 * duplicate delivery older than a rotation's grace period is refused as a
 * conflict. Nothing else depends on the hash.
 */
export function contentHashMatches(keyring: Keyring, value: unknown, stored: string): boolean {
  if (DIGEST_PATTERN.test(stored)) return safeEqual(legacyContentHash(value), stored);

  const [version, keyId, digest, ...rest] = stored.split(".");
  if (version !== VERSION_PREFIX || keyId === undefined || digest === undefined) return false;
  if (rest.length > 0 || !DIGEST_PATTERN.test(digest)) return false;

  const material = keyMaterialFor(keyring, keyId);
  if (material === null) return false;
  return safeEqual(hmacHex(material.contentHash, value), digest);
}

/**
 * The unkeyed SHA-256 hash of a canonical value, as stored before ADR-048.
 *
 * Kept only to compare against rows written before hashes were keyed. Never
 * store it: it is the offline oracle ADR-048 removed.
 */
export function legacyContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function hmacHex(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalize(value), "utf8").digest("hex");
}

/** Both arguments are 64 hex characters by the time this is called. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`);
    return `{${entries.join(",")}}`;
  }

  // JSON.stringify is typed as returning string but yields undefined for values
  // it cannot represent. `undefined` is handled above; this covers functions and
  // symbols, which cannot appear in a JSON-parsed body but can reach an
  // `unknown` parameter.
  const serialized = JSON.stringify(value) as string | undefined;
  return serialized ?? "null";
}
