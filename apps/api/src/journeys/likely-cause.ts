import { normalizeKey, pairChanges, type Change, type PairedChange } from "@wayscribe/payload-diff";

/**
 * Past this many events a journey gets no likely causes (ADR-072): the
 * function never answers from part of a journey, and the read stays bounded.
 */
export const MAX_JOURNEY_EVENTS_FOR_CAUSES = 1_000;

/** One event as the search reads it, in timeline order. */
export interface CauseEvent {
  id: string;
  /** The event's `name`, its operation name. */
  step: string;
  /** It carries an error, or its operation is `failed`. */
  failed: boolean;
  /** The stored `error.fields`, unchecked: it is read back from the database. */
  fields: unknown;
  /** The stored `payload_diff`, unchecked, or null when the step has none. */
  diff: unknown;
}

export type CauseKind = "removed" | "changed" | "renamed-changed";

/** The nearest earlier step that changed a field a failure named (ADR-072). */
export interface LikelyCause {
  /** As the error reported it. */
  field: string;
  /** The event whose error named the field: the failure itself, or an earlier one. */
  reportedBy: string;
  /** The likely-cause step's event id and operation name. */
  eventId: string;
  step: string;
  change: {
    kind: CauseKind;
    /** The input had a non-null value and the output has null or nothing. */
    lost: boolean;
    /** The output-side path, or the input path when removed. */
    path: string;
    /** The input-side path, for a rename. */
    from?: string;
    /** As stored, so possibly masked. */
    before: unknown;
    after: unknown;
  };
  /** Every other earlier step that changed the field, nearest first. */
  alsoChangedAt: { eventId: string; step: string }[];
  /** A step nearer than the cause had a diff too large to check. */
  incomplete?: true;
}

const COUNTED: ReadonlySet<string> = new Set<CauseKind>(["removed", "changed", "renamed-changed"]);
const DIFF_KINDS: ReadonlySet<unknown> = new Set(["added", "removed", "changed"]);
/** A path's segments: `[3]` for an index, a key otherwise, as `diffPayloads` writes them. */
const SEGMENT = /\[\d+\]|[^.[\]]+/g;

/**
 * One candidate's diff, paired and indexed once per call: each counted row's
 * path, as normalized segments joined by `.`, to the first such row in
 * `pairChanges`' order (lost values first, so the most damaging match wins).
 */
interface IndexedDiff {
  rows: PairedChange[];
  byPath: Map<string, number>;
  /** Each proper prefix of a counted row's path to the first row below it. */
  below: Map<string, number>;
  truncated: boolean;
}

/** Prefixes indexed per changed path: a field deeper than this finds nothing below it. */
const MAX_PREFIX_DEPTH = 32;

/**
 * The likely causes of each failed event of one journey, keyed by its id.
 *
 * `events` is the whole journey in timeline order (`event_timestamp`,
 * `received_at`, `id`, as `listJourneyEvents` orders it). For each failed
 * event, the fields are its own error's, or else those of the most recent
 * earlier failed event that named some: the reporter. The candidates are the
 * events before the reporter that are not failed and have a stored diff; a
 * failed step is where a field was refused, not where it changed. A paired
 * change matches a field when its path equals the field, is an ancestor of it,
 * or is below it (a compound field, a parent parameter, a JSON Schema
 * instancePath), comparing keys as `normalizeKey` does and indexes literally,
 * so an error may name a renamed field by either its input or its output key.
 * `removed`, `changed` and `renamed-changed` count; a rename that kept the
 * value, an added field and a whole-payload replacement (path `""`) do not.
 * The nearest matching step is the cause, the rest are `alsoChangedAt`; within
 * one step a lost value wins, then the field or an ancestor over a change
 * below it, then `pairChanges`' order.
 *
 * A failed event before any reporter has no entry. A journey over
 * `MAX_JOURNEY_EVENTS_FOR_CAUSES` gets an empty map.
 *
 * Cost: each diff is paired and indexed at most once, and each reporter's
 * fields are searched once however many failures inherit them; a field costs
 * one lookup per segment per candidate, not one comparison per change.
 */
export function findLikelyCauses(events: readonly CauseEvent[]): Map<string, LikelyCause[]> {
  const causes = new Map<string, LikelyCause[]>();
  if (events.length > MAX_JOURNEY_EVENTS_FOR_CAUSES) return causes;

  const indexed = new Map<number, IndexedDiff | null>();
  const indexedAt = (index: number): IndexedDiff | null => {
    if (!indexed.has(index)) indexed.set(index, indexDiff(events[index]?.diff));
    return indexed.get(index) ?? null;
  };

  let reporter: { index: number; causes: LikelyCause[] } | null = null;
  for (const [index, event] of events.entries()) {
    if (!event.failed) continue;
    const own = reportedFields(event.fields);
    if (own !== null) {
      reporter = {
        index,
        causes: own.flatMap((field) => causeOf(events, indexedAt, field, index))
      };
    }
    if (reporter === null) continue;
    causes.set(event.id, [...reporter.causes]);
  }
  return causes;
}

function causeOf(
  events: readonly CauseEvent[],
  indexedAt: (index: number) => IndexedDiff | null,
  field: string,
  reporterIndex: number
): LikelyCause[] {
  const reporter = events[reporterIndex];
  const target = segments(field);
  const key = target.join(".");
  // A field that normalizes to nothing (`__c`) names no field.
  if (reporter === undefined || key === "") return [];
  // The field and each ancestor of it, as `byPath` keys.
  const covering = target.map((_, end) => target.slice(0, end + 1).join("."));

  const matches: { event: CauseEvent; row: PairedChange }[] = [];
  let incomplete = false;
  for (let index = reporterIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate === undefined || candidate.failed) continue;
    const diff = indexedAt(index);
    if (diff === null) continue;
    let first: number | undefined;
    for (const path of covering) {
      const at = diff.byPath.get(path);
      if (at !== undefined && (first === undefined || at < first)) first = at;
    }
    const row = pick(diff.rows, first, diff.below.get(key));
    if (row === undefined) {
      // Unknown, not unchanged: only a nearer one than the cause matters.
      if (diff.truncated && matches.length === 0) incomplete = true;
      continue;
    }
    matches.push({ event: candidate, row });
  }

  const [nearest, ...earlier] = matches;
  if (nearest === undefined) return [];
  const { row } = nearest;
  return [
    {
      field,
      reportedBy: reporter.id,
      eventId: nearest.event.id,
      step: nearest.event.step,
      change: {
        kind: row.kind as CauseKind,
        lost: row.lost,
        path: row.path,
        ...(row.from === null ? {} : { from: row.from }),
        before: row.before,
        after: row.after
      },
      alsoChangedAt: earlier.map(({ event }) => ({ eventId: event.id, step: event.step })),
      ...(incomplete ? { incomplete: true as const } : {})
    }
  ];
}

/**
 * One step's matching row: a lost value first, then the field or an ancestor
 * of it over a change below it, then `pairChanges`' order.
 */
function pick(
  rows: readonly PairedChange[],
  covering: number | undefined,
  below: number | undefined
): PairedChange | undefined {
  const atOrAbove = covering === undefined ? undefined : rows[covering];
  const under = below === undefined ? undefined : rows[below];
  if (atOrAbove === undefined) return under;
  if (under !== undefined && under.lost && !atOrAbove.lost) return under;
  return atOrAbove;
}

/** A list's distinct non-empty strings, or null when there are none. */
function reportedFields(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const fields = [
    ...new Set(value.filter((one): one is string => typeof one === "string" && one !== ""))
  ];
  return fields.length === 0 ? null : fields;
}

/** A stored diff, paired and indexed; null for anything that is not one. */
function indexDiff(value: unknown): IndexedDiff | null {
  if (typeof value !== "object" || value === null) return null;
  const { changes, truncated } = value as { changes?: unknown; truncated?: unknown };
  if (!Array.isArray(changes)) return null;
  const valid = changes.filter(
    (one): one is Change =>
      typeof one === "object" &&
      one !== null &&
      typeof (one as { path?: unknown }).path === "string" &&
      DIFF_KINDS.has((one as { kind?: unknown }).kind)
  );
  const rows = pairChanges(valid);
  const byPath = new Map<string, number>();
  const below = new Map<string, number>();
  rows.forEach((row, index) => {
    // Only the output-side path is indexed. A counted rename
    // (`renamed-changed`) is always a by-name pair: a by-value pair has equal
    // values, so it is a plain `renamed`. A by-name pair shares its parent and
    // its keys normalize equal, so its input-side path has the same segments.
    if (!COUNTED.has(row.kind)) return;
    const own = segments(row.path);
    // The empty path, a whole-payload replacement, covers no field: not even one
    // whose only key normalizes to nothing (`__c`), which would also join to "".
    if (own.length === 0) return;
    const key = own.join(".");
    if (!byPath.has(key)) byPath.set(key, index);
    // Each proper prefix, so a field above the change is one lookup.
    for (let end = 1; end < Math.min(own.length, MAX_PREFIX_DEPTH + 1); end += 1) {
      const prefix = own.slice(0, end).join(".");
      if (!below.has(prefix)) below.set(prefix, index);
    }
  });
  return { rows, byPath, below, truncated: truncated === true };
}

/** A path's segments, keys normalized; none contains a `.`, so `.` joins them unambiguously. */
function segments(path: string): string[] {
  return (path.match(SEGMENT) ?? []).map((segment) =>
    segment.startsWith("[") ? segment : normalizeKey(segment)
  );
}
