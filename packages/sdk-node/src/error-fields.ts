import { toStorableText } from "@wayscribe/payload-security/redaction";

/**
 * The limits on an error's `fields` (ADR-072), as the protocol accepts them: a
 * list of 1 to 20 non-empty paths of at most 200 code points.
 *
 * Copied, like the error text limits, because the SDK cannot import the
 * private protocol package at runtime; `error-fields.test.ts` holds them to
 * `errorSchema`.
 */
export const MAX_ERROR_FIELDS = 20;
export const MAX_ERROR_FIELD_LENGTH = 200;

/**
 * The `fields` an error carries, kept to what the server accepts, or
 * undefined when nothing usable is left.
 *
 * Read only from a list, and only its strings: each is made storable, an empty one is dropped, a
 * long one is cut by code point, and the list stops at twenty. Names, not
 * values, so nothing is masked (ADR-046 is for free text). Throws only what
 * the host's own value throws, such as a revoked Proxy or a getter on an
 * index; every caller reads it inside a `safely` boundary.
 */
export function errorFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "string") continue;
    // Repaired first, as message text and labels are: PostgreSQL cannot store
    // a NUL, and a lone surrogate is not valid JSON text. Then cut, then the
    // empty check, so a path that was only NULs is dropped.
    const path = cut(toStorableText(entry));
    if (path === "") continue;
    kept.push(path);
    if (kept.length === MAX_ERROR_FIELDS) break;
  }
  return kept.length === 0 ? undefined : kept;
}

/** At most 200 code points, so a character outside the BMP is never split. */
function cut(path: string): string {
  if (path.length <= MAX_ERROR_FIELD_LENGTH) return path;
  const points = Array.from(path);
  return points.length <= MAX_ERROR_FIELD_LENGTH
    ? path
    : points.slice(0, MAX_ERROR_FIELD_LENGTH).join("");
}
