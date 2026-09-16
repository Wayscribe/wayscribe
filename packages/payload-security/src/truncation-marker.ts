/**
 * The marker a cut string ends with, on its own so that the header masker can
 * recognise it without importing the truncation code (which imports the
 * redaction walk, which imports the masker).
 */

/**
 * What replaces the end of a cut string.
 *
 * "Characters" are UTF-16 code units, the unit the limit counts. The marker
 * belongs to the family the SDK already writes (`[REDACTED]`,
 * `[PAYLOAD_TOO_LARGE]`) and says how much is missing, which is what a reader
 * of a cut payload asks next. It names no product.
 */
export function truncationMarker(removed: number): string {
  return `[TRUNCATED: ${String(removed)} characters removed]`;
}

/** Matches a string that was cut, and captures how much was removed. */
export const TRUNCATION_MARKER_PATTERN = /\[TRUNCATED: (\d+) characters removed\]$/;
