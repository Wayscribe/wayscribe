import { JOURNEY_STATUSES, type JourneyStatus, type JourneyListFilters } from "@wayscribe/database";
import { MAX_ENTITY_TYPE_LENGTH, MAX_JOURNEY_LABEL_LENGTH } from "@wayscribe/protocol";
import {
  codePoints,
  instant,
  single,
  unknownKey,
  SINCE_CLOCK_TOLERANCE_MS
} from "./query-params.js";

export type ParsedJourneyListQuery =
  { ok: true; filters: JourneyListFilters } | { ok: false; message: string };

/**
 * The bounds of `q`, in code points, as every text cap in the protocol counts.
 *
 * One character would match nearly every row and still make the database test
 * every label and displayable value in the window. The upper bound is the
 * longest label, so a whole label can always be pasted back in.
 */
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = MAX_JOURNEY_LABEL_LENGTH;

/**
 * Every key this list reads. Anything else is refused: a misspelt filter
 * (`entity_type`) that was silently ignored would return an unfiltered list
 * that looks filtered.
 */
export const JOURNEY_LIST_PARAMETERS = [
  "since",
  "until",
  "status",
  "environment",
  "service",
  "entityType",
  "q",
  "limit",
  "cursor"
] as const;

/**
 * Required, with no default. A default computed here ("the last 24 hours")
 * would be recomputed for every page and move the window under the cursor,
 * and would hide that the list is windowed at all. The refusal says what to
 * send instead.
 */
const REQUIRED_MESSAGE =
  "since is required: the earliest last activity to list, as an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z.";

/**
 * Validate the query string of `GET /v1/journeys`.
 *
 * An empty value is treated as omitted, because that is what a plain GET form
 * sends for an unselected filter. `limit` and `cursor` are not handled here;
 * they parse the way every other list endpoint parses them.
 */
export function parseJourneyListQuery(query: unknown, now: Date): ParsedJourneyListQuery {
  const params = (query ?? {}) as Record<string, unknown>;

  const unknown = unknownKey(params, JOURNEY_LIST_PARAMETERS, "this list");
  if (unknown !== undefined) return { ok: false, message: unknown };

  const since = instant(params, "since");
  if (!since.ok) return since;
  if (since.value === undefined) return { ok: false, message: REQUIRED_MESSAGE };
  // A future bound can only return nothing, which reads as "nothing failed".
  // Saying so is more useful than an empty page.
  if (since.value.getTime() > now.getTime() + SINCE_CLOCK_TOLERANCE_MS) {
    return { ok: false, message: "since must not be in the future." };
  }

  // No clock check: a range that ends after now still lists everything up to
  // now, so a future until cannot hide anything the way a future since does.
  const until = instant(params, "until");
  if (!until.ok) return until;
  if (until.value !== undefined && until.value.getTime() <= since.value.getTime()) {
    return { ok: false, message: "until must be after since." };
  }

  const status = single(params, "status");
  if (!status.ok) return status;
  if (status.value !== undefined && !isJourneyStatus(status.value)) {
    return { ok: false, message: `status must be one of ${JOURNEY_STATUSES.join(", ")}.` };
  }

  const environment = single(params, "environment");
  if (!environment.ok) return environment;
  const service = single(params, "service");
  if (!service.ok) return service;

  const rawEntityType = single(params, "entityType");
  if (!rawEntityType.ok) return rawEntityType;
  // Trimmed, as the web form trims what is typed into it and as q is: a
  // stray space would otherwise match no type and read as "nothing here".
  // White space alone is an empty box. A type stored with surrounding white
  // space cannot be filtered on; the protocol allows one, no SDK sends one.
  const trimmedType = rawEntityType.value?.trim();
  const entityType = { value: trimmedType === "" ? undefined : trimmedType };
  // Longer than any type ingestion accepts, so it could only match nothing.
  if (entityType.value !== undefined && codePoints(entityType.value) > MAX_ENTITY_TYPE_LENGTH) {
    return {
      ok: false,
      message: `entityType must be at most ${String(MAX_ENTITY_TYPE_LENGTH)} characters.`
    };
  }

  const rawText = single(params, "q");
  if (!rawText.ok) return rawText;
  // Trimmed as search trims its q. White space alone is an empty box, which a
  // plain GET form sends when nothing was typed.
  const trimmed = rawText.value?.trim();
  const text = trimmed === "" ? undefined : trimmed;
  if (text !== undefined) {
    const length = codePoints(text);
    if (length < MIN_TEXT_LENGTH || length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        message: `q must be ${String(MIN_TEXT_LENGTH)} to ${String(MAX_TEXT_LENGTH)} characters.`
      };
    }
  }

  return {
    ok: true,
    filters: {
      since: since.value,
      until: until.value,
      status: status.value,
      environment: environment.value,
      service: service.value,
      entityType: entityType.value,
      text
    }
  };
}

function isJourneyStatus(value: string): value is JourneyStatus {
  return (JOURNEY_STATUSES as readonly string[]).includes(value);
}
