import { defineKey } from "./redact.js";

/**
 * The longest string ingestion accepts, in UTF-16 code units.
 *
 * The same number as `DEFAULT_LIMITS.maxStringLength`, which is defined in
 * terms of this one so the two cannot part.
 */
export const MAX_STRING_LENGTH = 65_536;

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

/** Matches a string {@link truncateText} cut, and captures how much it removed. */
export const TRUNCATION_MARKER_PATTERN = /\[TRUNCATED: (\d+) characters removed\]$/;

/**
 * `text` if it fits, or its start and a marker, exactly `max` code units long.
 *
 * The marker's length depends on the count it carries, and the count depends on
 * how much room the marker takes, so the two are settled together. The count
 * only grows from one round to the next and is bounded by the text's length, so
 * this ends within a round or two.
 *
 * A surrogate pair split by the cut is repaired to U+FFFD, one code unit, so the
 * length does not move and the result is always storable.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let removed = text.length - max;
  for (;;) {
    const marker = truncationMarker(removed);
    const kept = max - marker.length;
    // A limit shorter than the marker itself: nothing of the text fits.
    if (kept < 0) return marker.slice(0, max);
    const settled = text.length - kept;
    if (settled === removed) return text.slice(0, kept).toWellFormed() + marker;
    removed = settled;
  }
}

export interface TruncationStats {
  /** Strings that were cut. */
  strings: number;
  /** Code units removed from them, markers aside. */
  charactersRemoved: number;
}

/**
 * Every string in a JSON-compatible value cut to `max`, with a marker.
 *
 * Meant for what `toStorable(redact(...))` returns: plain objects, arrays and
 * primitives. Anything else is left as it is. Keys are not cut, because the
 * server's limit does not measure them.
 *
 * Returns the same reference when nothing needed cutting, so a payload that
 * fits costs one walk and no copy. Keys are written with `defineKey`, so a
 * `__proto__` key stays an own property, as everywhere else in this package.
 */
export function truncateStrings(
  value: unknown,
  max: number,
  stats: TruncationStats = { strings: 0, charactersRemoved: 0 }
): unknown {
  if (typeof value === "string") {
    if (value.length <= max) return value;
    const cut = truncateText(value, max);
    const removed = Number(TRUNCATION_MARKER_PATTERN.exec(cut)?.[1] ?? value.length);
    stats.strings += 1;
    stats.charactersRemoved += removed;
    return cut;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let changed = false;
    for (const child of value as unknown[]) {
      const next = truncateStrings(child, max, stats);
      if (next !== child) changed = true;
      result.push(next);
    }
    return changed ? result : value;
  }

  if (value === null || typeof value !== "object" || !isPlainObject(value)) return value;

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = truncateStrings(child, max, stats);
    if (next !== child) changed = true;
    defineKey(result, key, next);
  }
  return changed ? result : value;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
