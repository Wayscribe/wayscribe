import type { SearchFilters } from "@wayscribe/database";
import {
  FUTURE_SINCE_MESSAGE,
  instant,
  single,
  unknownKey,
  SINCE_CLOCK_TOLERANCE_MS
} from "./query-params.js";

export type ParsedSearchQuery =
  { ok: true; query: string; filters: SearchFilters } | { ok: false; message: string };

const NULL_BYTE = String.fromCharCode(0);

/**
 * Every key this search reads. Anything else is refused, as the journey list
 * refuses one: a misspelt `enviroment` that was silently ignored would return
 * a search of every environment that looks narrowed to one.
 */
export const SEARCH_PARAMETERS = ["q", "since", "until", "environment", "limit", "cursor"] as const;

/**
 * Validate the query string of `GET /v1/search`.
 *
 * `since`, `until` and `environment` are optional and were added by F-028: a
 * search had no window at all, so an alias value reused across runs returned
 * every journey that ever carried it. They are optional rather than required,
 * unlike the journey list's `since`, because search is the endpoint a person
 * reaches for with an identifier in hand and usually wants every trace of it;
 * with none of them the search spans the project's whole history, exactly as
 * it always has.
 *
 * `limit` and `cursor` are not handled here; they parse the way every other
 * list endpoint parses them.
 */
export function parseSearchQuery(query: unknown, now: Date): ParsedSearchQuery {
  const params = (query ?? {}) as Record<string, unknown>;

  const unknown = unknownKey(params, SEARCH_PARAMETERS, "this search");
  if (unknown !== undefined) return { ok: false, message: unknown };

  // q keeps its own reading rather than going through `single`: it is required,
  // it is trimmed, and its repeated-parameter message is the one callers
  // already see. A repeated parameter arrives as an array, which `.trim()`
  // threw on.
  const rawQuery = params["q"];
  if (Array.isArray(rawQuery)) return { ok: false, message: "q may be given once." };
  const text = typeof rawQuery === "string" ? rawQuery.trim() : undefined;
  if (text === undefined || text === "") return { ok: false, message: "q is required." };
  if (text.includes(NULL_BYTE)) {
    // Nothing stored can hold one, and PostgreSQL refuses it in a comparison.
    return { ok: false, message: "q must not contain a null byte." };
  }

  const since = instant(params, "since");
  if (!since.ok) return since;
  // A future bound can only return nothing, which reads as "this identifier was
  // never seen". Saying so is more useful than an empty page, and it is what
  // the journey list answers.
  if (
    since.value !== undefined &&
    since.value.getTime() > now.getTime() + SINCE_CLOCK_TOLERANCE_MS
  ) {
    return { ok: false, message: FUTURE_SINCE_MESSAGE };
  }

  // No clock check: a range that ends after now still searches everything up to
  // now, so a future until cannot hide anything the way a future since does.
  const until = instant(params, "until");
  if (!until.ok) return until;
  if (
    until.value !== undefined &&
    since.value !== undefined &&
    until.value.getTime() <= since.value.getTime()
  ) {
    return { ok: false, message: "until must be after since." };
  }

  const environment = single(params, "environment");
  if (!environment.ok) return environment;

  return {
    ok: true,
    query: text,
    filters: { since: since.value, until: until.value, environment: environment.value }
  };
}
