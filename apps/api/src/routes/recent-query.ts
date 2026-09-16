import {
  JOURNEY_STATUSES,
  type JourneyStatus,
  type RecentJourneyFilters
} from "@flight-recorder/database";
import { MAX_ENTITY_TYPE_LENGTH } from "@flight-recorder/protocol";

export type ParsedRecentQuery =
  { ok: true; filters: RecentJourneyFilters } | { ok: false; message: string };

/**
 * A full instant: date, time, and a zone. `Date.parse` would also take
 * "2026-09-14" or a zoneless time and read it in whatever zone the server runs
 * in, which turns a filter into a guess.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const instantMessage = (name: string): string =>
  `${name} must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z.`;

/**
 * The bounds of `q`, in code points, as every text cap in the protocol counts.
 *
 * One character would match nearly every row and still make the database test
 * every label and displayable value in the window. The upper bound is the
 * longest label, so a whole label can always be pasted back in.
 */
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = 200;

/**
 * Every key this list reads. Anything else is refused: a misspelt filter
 * (`entity_type`) that was silently ignored would return an unfiltered list
 * that looks filtered.
 */
export const RECENT_JOURNEYS_PARAMETERS = [
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
 * How far ahead of this server's clock `since` may be.
 *
 * The web app computes `since` from its own clock ("24 hours ago") and the API
 * checks it against another. A few seconds of skew between two containers is
 * normal and must not turn the Recent page into an error; a minute covers it
 * while still refusing a bound that is plainly in the future.
 */
const SINCE_CLOCK_TOLERANCE_MS = 60_000;

/**
 * Validate the query string of `GET /v1/journeys`.
 *
 * An empty value is treated as omitted, because that is what a plain GET form
 * sends for an unselected filter. `limit` and `cursor` are not handled here;
 * they parse the way every other list endpoint parses them.
 */
export function parseRecentJourneysQuery(query: unknown, now: Date): ParsedRecentQuery {
  const params = (query ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(params)) {
    if (!(RECENT_JOURNEYS_PARAMETERS as readonly string[]).includes(key)) {
      return {
        ok: false,
        message: `${key} is not a parameter of this list. Known parameters: ${RECENT_JOURNEYS_PARAMETERS.join(", ")}.`
      };
    }
  }

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

  const entityType = single(params, "entityType");
  if (!entityType.ok) return entityType;
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

/** One optional instant parameter, validated as `since` always was. */
function instant(
  params: Record<string, unknown>,
  name: string
): { ok: true; value: Date | undefined } | { ok: false; message: string } {
  const raw = single(params, name);
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true, value: undefined };
  const match = ISO_INSTANT.exec(raw.value);
  if (match === null || !isCalendarDate(match[1], match[2], match[3])) {
    return { ok: false, message: instantMessage(name) };
  }
  const parsed = new Date(raw.value);
  if (Number.isNaN(parsed.getTime())) return { ok: false, message: instantMessage(name) };
  return { ok: true, value: parsed };
}

function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Whether the date digits name a real day.
 *
 * V8 parses "2026-02-30T00:00:00Z" as 2 March instead of refusing it. The
 * date part is checked on its own, at midnight UTC, so an offset that moves
 * the instant into a neighbouring UTC day cannot cause a false rejection.
 */
function isCalendarDate(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined
): boolean {
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}

function isJourneyStatus(value: string): value is JourneyStatus {
  return (JOURNEY_STATUSES as readonly string[]).includes(value);
}

/** One string value, or undefined for absent or empty; a repeated key is an error. */
function single(
  params: Record<string, unknown>,
  name: string
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const raw = params[name];
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, message: `${name} must be given once.` };
  // PostgreSQL refuses a NUL in a comparison, and no stored name holds one.
  if (raw.includes(String.fromCharCode(0))) {
    return { ok: false, message: `${name} must not contain a null byte.` };
  }
  return { ok: true, value: raw };
}
