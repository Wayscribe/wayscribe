import type { DiffChange, EventDetailData, EventListItem, RowBuild } from "./api";
import { bounded, metadataEntries, runtimeFormat } from "./metadata";

/**
 * An event as the page shows it, made on the server from the API's answer.
 *
 * The event reaches the browser two ways: as a prop of the timeline on first
 * load, which React serialises, and as JSON from /api/events when a reader
 * chooses a step. React's serialisation drops an object key named
 * `__proto__`, at any depth, and JSON does not, so an event whose payload,
 * diff or metadata held one showed different keys on first load and after a
 * click. Everything user-supplied is therefore turned into text here, once,
 * and only text crosses: both ways carry exactly the same strings, because
 * both come from this function (`getEvent`).
 *
 * The text is what the components wrote before: payloads and errors
 * pretty-printed with two spaces, diff values compact, and an em dash for a
 * side a change does not have. No payload is cut: a payload over the SDK's
 * size limit arrives as a marker string, as before.
 */

/** A diff change with its values as the diff table shows them. */
export interface DisplayedChange {
  path: string;
  kind: DiffChange["kind"];
  before: string;
  after: string;
}

/** The event as `GET /v1/events/:id` answers it. */
export type ApiEventDetail = Omit<
  EventDetailData,
  | "inputText"
  | "outputText"
  | "errorText"
  | "payloadsCaptured"
  | "payloadDiff"
  | "metadata"
  | "statedAliases"
> & {
  inputPayload: unknown;
  outputPayload: unknown;
  error: unknown;
  payloadDiff: { changes: DiffChange[]; truncated: boolean } | null;
  customMetadata?: unknown;
  deploymentMetadata?: unknown;
  runtimeMetadata?: unknown;
  /** `[]`, null for an event stored before migration 020, absent from an older API. */
  aliases?: unknown;
};

/** Markers the SDK stores in place of a payload it could not capture. */
const MARKERS = new Set(["[PAYLOAD_TOO_LARGE]", "[UNCAPTURABLE]"]);

export function eventForDisplay(raw: ApiEventDetail): EventDetailData {
  const {
    inputPayload,
    outputPayload,
    error,
    payloadDiff,
    customMetadata,
    deploymentMetadata,
    runtimeMetadata,
    aliases,
    ...event
  } = raw;
  return {
    ...event,
    inputText: pretty(inputPayload),
    outputText: pretty(outputPayload),
    errorText: error === null ? null : pretty(error),
    // ADR-032: the diff table must not say "no fields changed" when one side
    // was never captured. The same test the page made on the raw values.
    payloadsCaptured: !MARKERS.has(String(inputPayload)) && !MARKERS.has(String(outputPayload)),
    payloadDiff:
      payloadDiff === null
        ? null
        : { changes: payloadDiff.changes.map(displayChange), truncated: payloadDiff.truncated },
    metadata: {
      custom: metadataEntries(customMetadata),
      deployment: metadataEntries(deploymentMetadata),
      // `sdk` reads as `<name> <version> at <commit>` (ADR-063).
      runtime: metadataEntries(runtimeMetadata, runtimeFormat)
    },
    statedAliases: statedAliases(aliases)
  };
}

/** One alias an event stated, as the page shows it. */
export interface StatedAlias {
  type: string;
  /** The value as the API gave it, masked or not, or `(no value)` when it gave none. */
  value: string;
  /** True unless the API said the alias is displayable (ADR-053). */
  masked: boolean;
}

/**
 * The aliases an event stated, from `GET /v1/events/:id` (F-042), as text.
 *
 * The API masks them the way the journey read does, so nothing is masked
 * here; a value it did not mark displayable is only marked as masked, as
 * `AliasList` marks the journey's. Null when the API did not record them (an
 * event stored before migration 020 reads `null`) or did not send the field.
 * An entry without a string `type` is left out rather than guessed at.
 */
function statedAliases(value: unknown): StatedAlias[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry: unknown): StatedAlias[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const own = (field: string): unknown =>
      Object.hasOwn(entry, field) ? (entry as Record<string, unknown>)[field] : undefined;
    const type = own("type");
    if (typeof type !== "string") return [];
    const displayValue = own("displayValue");
    return [
      {
        type: bounded(type),
        value: typeof displayValue === "string" ? bounded(displayValue) : "(no value)",
        masked: own("displayable") !== true
      }
    ];
  });
}

/** One diff change as text. Also used for a replay's comparison. */
export function displayChange(change: DiffChange): DisplayedChange {
  return {
    path: change.path,
    kind: change.kind,
    before: compact(change.before),
    after: compact(change.after)
  };
}

/** `JSON.stringify(value, null, 2)`, as the page wrote a payload; "" for nothing at all. */
function pretty(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function compact(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/** A timeline row as `GET /v1/journeys/:id/events` answers it. */
export type ApiEventRow = Omit<EventListItem, "build"> & { deploymentMetadata?: unknown };

/**
 * A timeline row as the page shows it (F-043): the row, with the build that
 * recorded it as text in place of the raw `deploymentMetadata`. Made on the
 * server by `listEvents`, which the journey page and the timeline's polls
 * both read rows through, for the reason `eventForDisplay` gives.
 */
export function rowForDisplay(raw: ApiEventRow): EventListItem {
  const { deploymentMetadata, ...row } = raw;
  return { ...row, build: buildOf(deploymentMetadata) };
}

/** Characters of a commit a row shows; the whole of it is in the title. */
const SHORT_COMMIT = 12;

/**
 * The version and commit a deployment names, or null when it names neither.
 * The image alone is left to the event detail's Deployment group, where it
 * is shown in full: on a one-line row it would only ever be cut. Read with
 * `Object.hasOwn`, as `runtimeFormat` reads the sdk entry.
 */
function buildOf(deployment: unknown): RowBuild | null {
  if (typeof deployment !== "object" || deployment === null || Array.isArray(deployment)) {
    return null;
  }
  const text = (field: string): string | null => {
    const value = Object.hasOwn(deployment, field)
      ? (deployment as Record<string, unknown>)[field]
      : undefined;
    return typeof value === "string" && value.trim() !== "" ? bounded(value) : null;
  };
  const version = text("version");
  const commit = text("gitCommit");
  if (version === null && commit === null) return null;

  const shortCommit = commit === null ? null : Array.from(commit).slice(0, SHORT_COMMIT).join("");
  const label =
    version === null
      ? `commit ${shortCommit ?? ""}`
      : shortCommit === null
        ? version
        : `${version} · ${shortCommit}`;
  const named = [
    ...(version === null ? [] : [`version ${version}`]),
    ...(commit === null ? [] : [`commit ${commit}`])
  ];
  return { label, title: `Recorded by ${named.join(", ")}` };
}
