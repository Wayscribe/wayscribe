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

interface PairedDiff {
  rows: PairedChange[];
  truncated: boolean;
}

/**
 * The likely causes of each failed event of one journey, keyed by its id.
 *
 * `events` is the whole journey in timeline order (`event_timestamp`,
 * `received_at`, `id`, as `listJourneyEvents` orders it). For each failed
 * event, the fields are its own error's, or else those of the most recent
 * earlier failed event that named some: the reporter. The candidates are the
 * events before the reporter that are not failed and have a stored diff; a
 * failed step is where a field was refused, not where it changed. A paired
 * change matches a field when its path equals the field or is an ancestor of
 * it, comparing keys as `normalizeKey` does and indexes literally, so an error
 * may name a renamed field by either its input or its output key. `removed`, `changed` and `renamed-changed` count; a rename that
 * kept the value, an added field and a whole-payload replacement (path `""`)
 * do not. The nearest match is the cause, the rest are `alsoChangedAt`.
 *
 * A failed event before any reporter has no entry. A journey over
 * `MAX_JOURNEY_EVENTS_FOR_CAUSES` gets an empty map.
 */
export function findLikelyCauses(events: readonly CauseEvent[]): Map<string, LikelyCause[]> {
  const causes = new Map<string, LikelyCause[]>();
  if (events.length > MAX_JOURNEY_EVENTS_FOR_CAUSES) return causes;

  // Each diff is paired once, however many failures look back past it.
  const paired = new Map<number, PairedDiff | null>();
  const pairedAt = (index: number): PairedDiff | null => {
    if (!paired.has(index)) paired.set(index, pairedDiff(events[index]?.diff));
    return paired.get(index) ?? null;
  };

  let reporter: { index: number; fields: string[] } | null = null;
  for (const [index, event] of events.entries()) {
    if (!event.failed) continue;
    const own = reportedFields(event.fields);
    if (own !== null) reporter = { index, fields: own };
    if (reporter === null) continue;
    const reporterIndex = reporter.index;
    causes.set(
      event.id,
      reporter.fields.flatMap((field) => causeOf(events, pairedAt, field, reporterIndex))
    );
  }
  return causes;
}

function causeOf(
  events: readonly CauseEvent[],
  pairedAt: (index: number) => PairedDiff | null,
  field: string,
  reporterIndex: number
): LikelyCause[] {
  const reporter = events[reporterIndex];
  const target = segments(field);
  if (reporter === undefined || target.length === 0) return [];

  const matches: { event: CauseEvent; row: PairedChange }[] = [];
  let incomplete = false;
  for (let index = reporterIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate === undefined || candidate.failed) continue;
    const diff = pairedAt(index);
    if (diff === null) continue;
    // `pairChanges` puts lost values first, so the most damaging match wins.
    // Only the output-side path is checked. A counted rename (`renamed-changed`)
    // is always a by-name pair: a by-value pair has equal values, so it is a
    // plain `renamed`. A by-name pair shares its parent and its keys normalize
    // equal, so its input-side path has the same segments as `path`.
    const row = diff.rows.find((one) => COUNTED.has(one.kind) && covers(one.path, target));
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

/** A list's distinct non-empty strings, or null when there are none. */
function reportedFields(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const fields = [
    ...new Set(value.filter((one): one is string => typeof one === "string" && one !== ""))
  ];
  return fields.length === 0 ? null : fields;
}

/** A stored diff, paired; null for anything that is not one. */
function pairedDiff(value: unknown): PairedDiff | null {
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
  return { rows: pairChanges(valid), truncated: truncated === true };
}

function segments(path: string): string[] {
  return (path.match(SEGMENT) ?? []).map((segment) =>
    segment.startsWith("[") ? segment : normalizeKey(segment)
  );
}

/** Whether `path` is the target or an ancestor of it. The empty path is neither. */
function covers(path: string, target: readonly string[]): boolean {
  const own = segments(path);
  return (
    own.length > 0 &&
    own.length <= target.length &&
    own.every((segment, index) => segment === target[index])
  );
}
