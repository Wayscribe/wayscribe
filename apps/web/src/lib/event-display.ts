import type { DiffChange, EventDetailData } from "./api";
import { metadataEntries, runtimeFormat } from "./metadata";

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
  "inputText" | "outputText" | "errorText" | "payloadsCaptured" | "payloadDiff" | "metadata"
> & {
  inputPayload: unknown;
  outputPayload: unknown;
  error: unknown;
  payloadDiff: { changes: DiffChange[]; truncated: boolean } | null;
  customMetadata?: unknown;
  deploymentMetadata?: unknown;
  runtimeMetadata?: unknown;
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
    }
  };
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
