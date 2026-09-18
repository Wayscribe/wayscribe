/**
 * Search's narrowing, read from its URL: a time window and an environment,
 * the `since`, `until` and `environment` `GET /v1/search` accepts
 * (docs/API_SPEC.md section 5).
 *
 * The Search page is a plain GET form, like the Journeys page, so these arrive
 * as text a person can edit, and they are read with the Journeys page's own
 * helpers (`journey-filters.ts`): a value the API would refuse is set aside
 * with a note rather than sent, the same way on both pages.
 *
 * One difference, on purpose. With no window chosen the Journeys page shows
 * the last 24 hours; search spans the whole history, as the API does without
 * one, because it is what a person reaches for with an identifier in hand. So
 * a range that cannot be used falls back to all time, and the note says so,
 * because that is a wider search than the one asked for.
 */
import {
  JOURNEY_PRESETS,
  customRange,
  echo,
  readable,
  single,
  text,
  toDateTimeLocal,
  type JourneyPreset,
  type SearchParams
} from "./journey-filters";

/** An empty string is "any time": what the form's first option sends. */
export type SearchWindow = JourneyPreset | "custom" | "";

export interface SearchFilters {
  /** The identifier searched for, trimmed. Empty means no search yet. */
  q: string;
  window: SearchWindow;
  /** Empty means every environment. */
  environment: string;
  /** The instant the window starts from, ISO-8601; empty means no lower bound. */
  since: string;
  /** The instant the window ends before, ISO-8601; empty means up to now. */
  until: string;
  /** What the custom range inputs show. */
  sinceInput: string;
  untilInput: string;
  /** Filters that were set aside, in words the page shows. */
  notes: string[];
}

const ALL_TIME = "all time";

export function readSearchFilters(params: SearchParams, now: Date): SearchFilters {
  const notes: string[] = [];
  const read = (key: string): string | undefined => single(params, key, notes);

  const q = read("q")?.trim() ?? "";

  const rawWindow = read("window");
  let window: SearchWindow = "";
  if (rawWindow === "custom" || (rawWindow !== undefined && isPreset(rawWindow))) {
    window = rawWindow;
  } else if (rawWindow !== undefined && rawWindow !== "") {
    notes.push(
      `Time "${echo(rawWindow)}" is not one of the choices, so this searches ${ALL_TIME}.`
    );
  }

  const rawSince = read("since");
  const rawUntil = read("until");
  const environment = text(read("environment"), "environment", notes, () => null);

  let since = "";
  let until = "";
  let sinceInput = "";
  let untilInput = "";

  if (window === "custom") {
    const range = customRange(rawSince, rawUntil, now);
    if (range.ok) {
      since = range.since;
      until = range.until;
      sinceInput = toDateTimeLocal(range.since);
      untilInput = range.until === "" ? "" : toDateTimeLocal(range.until);
    } else {
      notes.push(`The custom range was not used (${range.reason}), so this searches ${ALL_TIME}.`);
      window = "";
      sinceInput = rawSince ?? "";
      untilInput = rawUntil ?? "";
    }
  } else {
    if (window !== "") {
      since = new Date(now.getTime() - JOURNEY_PRESETS[window].milliseconds).toISOString();
    }
    if ((rawSince ?? "") !== "" || (rawUntil ?? "") !== "") {
      notes.push(
        `The custom range applies only when Time is custom range, so this searches ${windowWords(window)}.`
      );
    }
  }

  return { q, window, environment, since, until, sinceInput, untilInput, notes };
}

/** The query string for `GET /v1/search`. */
export function searchApiQuery(filters: SearchFilters): string {
  const query = new URLSearchParams({ q: filters.q });
  if (filters.since !== "") query.set("since", filters.since);
  if (filters.until !== "") query.set("until", filters.until);
  if (filters.environment !== "") query.set("environment", filters.environment);
  return query.toString();
}

/**
 * What the results are narrowed to, or null when they are not. Says what the
 * window is measured on, a journey's last activity, because that is not the
 * time of the event that matched.
 */
export function describeSearchScope(filters: SearchFilters): string | null {
  if (filters.window === "" && filters.environment === "") return null;
  const parts = ["Journeys"];
  if (filters.environment !== "") parts.push(`in ${filters.environment}`);
  if (filters.window !== "") parts.push(`whose last activity is ${rangeWords(filters)}`);
  return `${parts.join(" ")}.`;
}

function rangeWords(filters: SearchFilters): string {
  if (filters.window !== "custom") return `in ${windowWords(filters.window)}`;
  return filters.until === ""
    ? `since ${readable(filters.since)} UTC`
    : `from ${readable(filters.since)} to ${readable(filters.until)} UTC`;
}

function windowWords(window: JourneyPreset | ""): string {
  return window === "" ? ALL_TIME : `the ${JOURNEY_PRESETS[window].label}`;
}

function isPreset(value: string): value is JourneyPreset {
  return Object.hasOwn(JOURNEY_PRESETS, value);
}
