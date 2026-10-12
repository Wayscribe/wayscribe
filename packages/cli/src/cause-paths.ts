/**
 * The likely-cause line's path test (ADR-072): whether the changed path lies
 * below the field a failure reported, as the API matches it. The web app has
 * the same code (`apps/web/src/lib/likely-cause-display.ts`) and the package
 * has the same `normalizeKey`; this published CLI depends on neither, so
 * `tests/diff-pairing-parity.test.ts` holds the copies to one text and one
 * behaviour.
 */

/**
 * `normalizeKey` from `@wayscribe/payload-diff`: lowercase, drop a trailing
 * Salesforce custom-field `__c`, drop `_` and `-`.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/__c$/, "").replace(/[_-]/g, "");
}

// isBelow: begin
/** A path's segments: `[3]` for an index, a key otherwise, as the API matches them. */
const SEGMENT = /\[\d+\]|[^.[\]]+/g;

/**
 * Whether `path` lies strictly below `field`, comparing keys as the API's
 * matching does (`normalizeKey`, indexes literally): `address.postalCode`
 * below `address`, but not `status` below `Status__c`, which is the field.
 */
export function isBelow(path: string, field: string): boolean {
  const changed = segments(path);
  const reported = segments(field);
  return (
    reported.length > 0 &&
    changed.length > reported.length &&
    reported.every((segment, index) => segment === changed[index])
  );
}

function segments(path: string): string[] {
  return (path.match(SEGMENT) ?? []).map((segment) =>
    segment.startsWith("[") ? segment : normalizeKey(segment)
  );
}
// isBelow: end

/** The web app's `MAX_METADATA_TEXT`: the longest text a likely-cause line repeats. */
export const MAX_CAUSE_TEXT = 300;

/** At most `MAX_CAUSE_TEXT` code points, then `…`, as the web app's `bounded`. */
export function bounded(text: string): string {
  // A string's length counts UTF-16 units, never fewer than its code points.
  if (text.length <= MAX_CAUSE_TEXT) return text;
  const characters = Array.from(text);
  return characters.length <= MAX_CAUSE_TEXT
    ? text
    : `${characters.slice(0, MAX_CAUSE_TEXT).join("")}…`;
}
