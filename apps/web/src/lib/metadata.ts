/**
 * An event's metadata as a list a page can show: key and value, both text.
 *
 * Metadata is whatever the instrumented code sent, so nothing here trusts its
 * shape or its size. Values become text (a string as it is, anything else as
 * compact JSON), and the page renders that text through React, which escapes
 * it: nothing in metadata is ever read as markup. Both the number of entries
 * and the length of each key and value are bounded, so one event carrying a
 * large object cannot make the page unreadable.
 */

/** Entries listed per kind of metadata; the rest are counted, not shown. */
export const MAX_METADATA_ENTRIES = 50;

/** Characters, as code points, shown of a key or a value before it is cut. */
export const MAX_METADATA_TEXT = 300;

export interface MetadataEntry {
  key: string;
  value: string;
}

export interface MetadataList {
  entries: MetadataEntry[];
  /** How many entries were left out past `MAX_METADATA_ENTRIES`. */
  omitted: number;
}

/** An event's three kinds of metadata, each as a list. */
export interface EventMetadataLists {
  custom: MetadataList;
  deployment: MetadataList;
  runtime: MetadataList;
}

/**
 * How one entry's value is written, when it is not written as compact JSON.
 * Returns undefined to leave the value to the default. Given the key as the
 * object holds it, before it is cut.
 */
export type EntryFormat = (key: string, value: unknown) => string | undefined;

export function metadataEntries(value: unknown, format?: EntryFormat): MetadataList {
  if (value === undefined || value === null) return { entries: [], omitted: 0 };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { entries: [{ key: "(value)", value: bounded(asText(value)) }], omitted: 0 };
  }

  // Object.keys, not a `for in`: it lists own keys only, and it lists a key
  // named `__proto__` that JSON.parse created as the own key it is. Called on
  // the server, on the API's parsed JSON (`getEvent`), before the event
  // crosses to the browser: React's serialisation of a prop drops such a key,
  // and the lists this returns carry it as text.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return {
    entries: keys.slice(0, MAX_METADATA_ENTRIES).map((key) => ({
      key: bounded(key),
      value: bounded(format?.(key, record[key]) ?? asText(record[key]))
    })),
    omitted: Math.max(0, keys.length - MAX_METADATA_ENTRIES)
  };
}

/**
 * The Runtime group's one formatted entry (ADR-063, F-046): `sdk`, the SDK
 * that recorded the event, written `<name> <version>`, then ` at <commit>`
 * when there is one. Anything else under `sdk`, from another client or an
 * older build, is left to the compact JSON every entry gets. Read with
 * `Object.hasOwn`, so nothing is taken from a prototype; the value arrives
 * parsed from JSON, where a key named `__proto__` is an own key and not one.
 */
export const runtimeFormat: EntryFormat = (key, value) => {
  // An array has no own `name`, so it falls through to compact JSON below.
  if (key !== "sdk" || typeof value !== "object" || value === null) return undefined;
  const own = (field: string): unknown =>
    Object.hasOwn(value, field) ? (value as Record<string, unknown>)[field] : undefined;
  const name = own("name");
  const version = own("version");
  if (typeof name !== "string" || typeof version !== "string") return undefined;
  const commit = own("commit");
  return typeof commit === "string" ? `${name} ${version} at ${commit}` : `${name} ${version}`;
};

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  // The value came from a JSON response, so it has no cycle or BigInt to throw
  // on, and `undefined`, which serialises to nothing, is the one case to name.
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * Cut by code point, so a character outside the BMP is never split in half.
 * Also bounds the aliases an event stated (`event-display.ts`).
 */
export function bounded(text: string): string {
  // A string's length counts UTF-16 units, never fewer than its code points.
  if (text.length <= MAX_METADATA_TEXT) return text;
  const characters = Array.from(text);
  return characters.length <= MAX_METADATA_TEXT
    ? text
    : `${characters.slice(0, MAX_METADATA_TEXT).join("")}…`;
}
