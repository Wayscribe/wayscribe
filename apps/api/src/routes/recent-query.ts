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
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const INSTANT_MESSAGE = "since must be an ISO-8601 instant with a time zone.";

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
  if (!ISO_INSTANT.test(since.value)) return { ok: false, message: INSTANT_MESSAGE };
  const sinceDate = new Date(since.value);
  if (Number.isNaN(sinceDate.getTime())) return { ok: false, message: INSTANT_MESSAGE };
  // A future bound can only return nothing, which reads as "nothing failed".
  // Saying so is more useful than an empty page.
  if (sinceDate.getTime() > now.getTime()) {
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
  return { ok: true, value: raw };
}
