import {
  JOURNEY_STATUSES,
  type JourneyStatus,
  type RecentJourneyFilters
} from "@flight-recorder/database";

export type ParsedRecentQuery =
  { ok: true; filters: RecentJourneyFilters } | { ok: false; message: string };

/**
 * A full instant: date, time, and a zone. `Date.parse` would also take
 * "2026-09-14" or a zoneless time and read it in whatever zone the server runs
 * in, which turns a filter into a guess.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const INSTANT_MESSAGE = "since must be an ISO-8601 instant with a time zone.";

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

  const since = single(params, "since");
  if (!since.ok) return since;
  if (since.value === undefined) return { ok: false, message: "since is required." };
  const match = ISO_INSTANT.exec(since.value);
  if (match === null || !isCalendarDate(match[1], match[2], match[3])) {
    return { ok: false, message: INSTANT_MESSAGE };
  }
  const sinceDate = new Date(since.value);
  if (Number.isNaN(sinceDate.getTime())) return { ok: false, message: INSTANT_MESSAGE };
  // A future bound can only return nothing, which reads as "nothing failed".
  // Saying so is more useful than an empty page.
  if (sinceDate.getTime() > now.getTime() + SINCE_CLOCK_TOLERANCE_MS) {
    return { ok: false, message: "since must not be in the future." };
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

  return {
    ok: true,
    filters: {
      since: sinceDate,
      status: status.value,
      environment: environment.value,
      service: service.value
    }
  };
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
