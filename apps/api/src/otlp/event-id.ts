import { createHmac } from "node:crypto";
import type { KeyMaterial, Keyring } from "@wayscribe/payload-security";

/** Separates this use of the content-hash subkey from the stored content hash. */
const LABEL = "wayscribe/otlp-event-id";

/**
 * Event ids for OTLP records that state none, derived from the record's
 * canonical content: `otlp_<hex>`, an HMAC-SHA256 under a key derived from the
 * content-hash subkey.
 *
 * Keyed for the reason the content hash is (ADR-048): the content is the
 * unredacted record, and the id is stored and shown beside the masked row, so
 * an unkeyed digest would confirm a guessed secret offline. The current key's
 * id comes first; during a rotation the previous key's follows, so the route
 * can find an event a retry's first attempt stored before the rotation.
 */
export function otlpFallbackEventIds(
  keyring: Keyring
): (content: string) => readonly [string, ...string[]] {
  const current = derivedKey(keyring.current);
  const previous = keyring.previous === null ? null : derivedKey(keyring.previous);
  return (content) => {
    const first = eventId(current, content);
    return previous === null ? [first] : [first, eventId(previous, content)];
  };
}

function derivedKey(material: KeyMaterial): Buffer {
  return createHmac("sha256", material.contentHash).update(LABEL, "utf8").digest();
}

function eventId(key: Buffer, content: string): string {
  return `otlp_${createHmac("sha256", key).update(content, "utf8").digest("hex")}`;
}
