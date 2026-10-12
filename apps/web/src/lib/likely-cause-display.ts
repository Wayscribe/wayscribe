import { normalizeKey } from "./diff-pairing";
import { bounded } from "./metadata";

/**
 * A likely cause (ADR-072) as the page shows it, made on the server from the
 * API's `likelyCauses`, for the reason `eventForDisplay` gives: only text
 * crosses to the browser.
 */
export interface DisplayedLikelyCause {
  /** The field as the failing system named it. */
  field: string;
  /**
   * The changed path when it lies below `field` (an error that names
   * `address` for a bad `address.postalCode`), since `before` and `after` are
   * that path's values. Null when the change is at the field or above it.
   */
  changedPath: string | null;
  /** The event whose error named the field. */
  reportedBy: string;
  /** The step that likely caused the failure, and its event. */
  eventId: string;
  step: string;
  /** What that step did to the field. */
  verb: "lost" | "removed" | "changed";
  /** As stored, so possibly masked: a string as it is, anything else as JSON, `—` for none. */
  before: string;
  after: string;
  /** Earlier steps that also changed the field, nearest first. */
  alsoChangedAt: { eventId: string; step: string }[];
  /** A nearer step's changes were too large to check. */
  incomplete: boolean;
}

const KINDS: ReadonlySet<unknown> = new Set(["removed", "changed", "renamed-changed"]);
/** A path's segments: `[3]` for an index, a key otherwise, as the API matches them. */
const SEGMENT = /\[\d+\]|[^.[\]]+/g;

/**
 * The API's `likelyCauses` as text. An entry it cannot read is left out
 * rather than guessed at, and only a value's own keys are read, as
 * `statedAliases` reads an alias. A cause object is never changed.
 */
export function likelyCausesForDisplay(value: unknown): DisplayedLikelyCause[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): DisplayedLikelyCause[] => {
    const field = text(own(entry, "field"));
    const reportedBy = text(own(entry, "reportedBy"));
    const eventId = text(own(entry, "eventId"));
    const step = text(own(entry, "step"));
    const change = own(entry, "change");
    const kind = own(change, "kind");
    if (
      field === null ||
      reportedBy === null ||
      eventId === null ||
      step === null ||
      !KINDS.has(kind)
    ) {
      return [];
    }
    const lost = own(change, "lost") === true;
    const path = own(change, "path");
    return [
      {
        field,
        changedPath:
          typeof path === "string" && isBelow(path, own(entry, "field") as string)
            ? bounded(path)
            : null,
        reportedBy,
        eventId,
        step,
        verb: lost ? "lost" : kind === "removed" ? "removed" : "changed",
        before: valueText(own(change, "before")),
        after: valueText(own(change, "after")),
        alsoChangedAt: earlierSteps(own(entry, "alsoChangedAt")),
        incomplete: own(entry, "incomplete") === true
      }
    ];
  });
}

/**
 * Whether `path` lies strictly below `field`, comparing keys as the API's
 * matching does (`normalizeKey`, indexes literally): `address.postalCode`
 * below `address`, but not `status` below `Status__c`, which is the field.
 */
function isBelow(path: string, field: string): boolean {
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

function earlierSteps(value: unknown): { eventId: string; step: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const eventId = text(own(entry, "eventId"));
    const step = text(own(entry, "step"));
    return eventId === null || step === null ? [] : [{ eventId, step }];
  });
}

/** A key the object holds itself, never one it inherits. */
function own(value: unknown, key: string): unknown {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? bounded(value) : null;
}

function valueText(value: unknown): string {
  if (value === undefined) return "—";
  return bounded(typeof value === "string" ? value : JSON.stringify(value));
}
