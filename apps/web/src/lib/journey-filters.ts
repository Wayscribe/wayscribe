/**
 * The Journeys page's filters, read from its URL.
 *
 * The page is a plain GET form, so everything here arrives as query-string
 * text a person can edit. Values the API would refuse are set aside rather
 * than sent: a hand-edited URL should still show a sensible page, and the API
 * would otherwise refuse the request and the page could only say so. What was
 * set aside is named in `notes`, so the page never silently shows a wider list
 * than the one asked for.
 *
 * The helpers that read one value (`single`, `text`, `customRange`) are
 * exported for the Search page's narrowing (`search-filters.ts`), so both
 * pages set a value aside the same way.
 */

export const JOURNEY_STATUSES = ["failed", "active", "completed"] as const;
/** An empty string is "any status": what the form's first option sends. */
export type JourneyStatusFilter = (typeof JOURNEY_STATUSES)[number] | "";

export const JOURNEY_PRESETS = {
  "1h": { label: "last hour", milliseconds: 60 * 60 * 1000 },
  "24h": { label: "last 24 hours", milliseconds: 24 * 60 * 60 * 1000 },
  "7d": { label: "last 7 days", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "last 30 days", milliseconds: 30 * 24 * 60 * 60 * 1000 }
} as const;
export type JourneyPreset = keyof typeof JOURNEY_PRESETS;
export type JourneyWindow = JourneyPreset | "custom";

const DEFAULT_PRESET: JourneyPreset = "24h";

/**
 * The API's bounds for `q`, in code points (docs/API_SPEC.md section 6), and
 * for `entityType`, the longest type ingestion accepts.
 *
 * Restated rather than imported: the web app depends on no workspace package,
 * and its image carries only its own dependencies. `tests/web-bounds.test.ts` checks them against the protocol's constants.
 */
export const MIN_TEXT_LENGTH = 2;
export const MAX_TEXT_LENGTH = 200;
export const MAX_ENTITY_TYPE_LENGTH = 128;
export const MAX_TIMING_MS = 2_147_483_647;

export interface JourneyFilters {
  /** Partial text over labels and displayable alias values. Empty means none. */
  q: string;
  status: JourneyStatusFilter;
  window: JourneyWindow;
  /** Empty means any entity type. */
  entityType: string;
  /** Empty means every environment. */
  environment: string;
  /** Empty means any service. */
  service: string;
  /** Strict journey-span threshold in whole milliseconds; empty means none. */
  minDurationMs: string;
  /** Strict per-step duration threshold in whole milliseconds; empty means none. */
  minStepDurationMs: string;
  /** How long an active journey has been quiet, in whole milliseconds. */
  inactiveForMs: string;
  /** The frozen API cutoff derived from inactiveForMs. */
  inactiveBefore: string;
  /** The instant the list starts from, ISO-8601. */
  since: string;
  /** The instant the list ends before, ISO-8601; empty means up to now. */
  until: string;
  /** What the custom range inputs show; empty under a preset. */
  sinceInput: string;
  untilInput: string;
  /** Empty on the first page. */
  cursor: string;
  /** Filters that were set aside, in words the page shows. */
  notes: string[];
}

export type SearchParams = Record<string, string | string[] | undefined>;

export function readJourneyFilters(params: SearchParams, now: Date): JourneyFilters {
  const notes: string[] = [];
  const read = (key: string): string | undefined => single(params, key, notes);

  const rawStatus = read("status");
  let status: JourneyStatusFilter = "";
  if (rawStatus !== undefined && isStatus(rawStatus)) {
    status = rawStatus;
  } else if (rawStatus !== undefined && rawStatus !== "") {
    notes.push(
      `Status "${echo(rawStatus)}" is not failed, active or completed, so every status is shown.`
    );
  }

  const rawWindow = read("window");
  let requested: JourneyWindow = DEFAULT_PRESET;
  if (rawWindow === "custom" || (rawWindow !== undefined && isPreset(rawWindow))) {
    requested = rawWindow;
  } else if (rawWindow !== undefined && rawWindow !== "") {
    notes.push(
      `Time "${echo(rawWindow)}" is not one of the choices, so this shows the ${JOURNEY_PRESETS[DEFAULT_PRESET].label}.`
    );
  }

  let cursor = read("cursor") ?? "";
  const rawSince = read("since");
  const rawUntil = read("until");

  const q = text(read("q"), "contains", notes, (value) => {
    const length = codePoints(value);
    return length < MIN_TEXT_LENGTH || length > MAX_TEXT_LENGTH
      ? `Contains needs ${String(MIN_TEXT_LENGTH)} to ${String(MAX_TEXT_LENGTH)} characters, so it was left out.`
      : null;
  });
  const entityType = text(read("entityType"), "entity type", notes, (value) =>
    codePoints(value) > MAX_ENTITY_TYPE_LENGTH
      ? `An entity type is at most ${String(MAX_ENTITY_TYPE_LENGTH)} characters, so that filter was left out.`
      : null
  );
  const environment = text(read("environment"), "environment", notes, () => null);
  const service = text(read("service"), "service", notes, () => null);
  const minDurationMs = milliseconds(read("minDurationMs"), "Minimum journey duration", notes);
  const minStepDurationMs = milliseconds(read("minStepDurationMs"), "Minimum step duration", notes);
  let inactiveForMs = milliseconds(read("inactiveForMs"), "Inactive for", notes);
  const rawInactiveBefore = read("inactiveBefore");
  let inactiveBefore = "";

  if (inactiveForMs !== "") {
    if (rawStatus !== undefined && rawStatus !== "" && rawStatus !== "active") {
      notes.push("Inactive for applies only to active journeys, so it was left out.");
      inactiveForMs = "";
    } else {
      status = "active";
      inactiveBefore =
        rawInactiveBefore !== undefined && isOwnInstant(rawInactiveBefore, now)
          ? rawInactiveBefore
          : new Date(now.getTime() - Number(inactiveForMs)).toISOString();
      if (rawInactiveBefore !== undefined && !isOwnInstant(rawInactiveBefore, now)) {
        notes.push("The saved inactivity cutoff was invalid, so it was recomputed.");
      }
    }
  } else if (rawInactiveBefore !== undefined && rawInactiveBefore !== "") {
    notes.push("An inactivity cutoff needs an Inactive for value, so it was left out.");
  }

  let window: JourneyWindow = requested;
  let since: string;
  let until = "";
  let sinceInput = "";
  let untilInput = "";

  if (requested === "custom") {
    const range = customRange(rawSince, rawUntil, now);
    if (range.ok) {
      since = range.since;
      until = range.until;
      sinceInput = toDateTimeLocal(range.since);
      untilInput = range.until === "" ? "" : toDateTimeLocal(range.until);
    } else {
      notes.push(
        `The custom range was not used (${range.reason}), so this shows the ${JOURNEY_PRESETS[DEFAULT_PRESET].label}.`
      );
      window = DEFAULT_PRESET;
      since = presetSince(DEFAULT_PRESET, now);
      // Echoed so the reader can correct what they typed.
      sinceInput = rawSince ?? "";
      untilInput = rawUntil ?? "";
    }
  } else {
    // A next-page link carries the since its first page used. Recomputing it
    // from the preset would slide the list under the cursor between pages. It
    // is honoured only beside a cursor, because that is the only link that
    // carries one for a preset: a bare `?since=2000-…&window=1h` would
    // otherwise list years of journeys under "in the last hour". Anything that
    // is not an instant this function could have written is recomputed too.
    //
    // A range beside a preset is otherwise set aside with a note: an until
    // always (no link this page writes carries one for a preset), and a since
    // when there is no cursor, which is a range typed into the form, or left
    // there, before Time was changed.
    const rangeNote = `The custom range applies only when Time is custom range, so this shows the ${JOURNEY_PRESETS[requested].label}.`;
    if (rawUntil !== undefined && rawUntil !== "") notes.push(rangeNote);
    since =
      cursor !== "" && notes.length === 0 && rawSince !== undefined && isOwnInstant(rawSince, now)
        ? rawSince
        : presetSince(requested, now);
    if (cursor === "" && rawSince !== undefined && rawSince !== "" && !notes.includes(rangeNote)) {
      notes.push(rangeNote);
    }
  }

  // The API does not refuse a cursor sent with different filters: it lists
  // the rows those filters match after that position. A cursor from a list
  // whose filters were just set aside would continue a different list under
  // this one's heading, so start from the top instead.
  if (notes.length > 0) cursor = "";

  return {
    q,
    status,
    window,
    entityType,
    environment,
    service,
    minDurationMs,
    minStepDurationMs,
    inactiveForMs,
    inactiveBefore,
    since,
    until,
    sinceInput,
    untilInput,
    cursor,
    notes
  };
}

/**
 * An instant written the way a `datetime-local` input shows it, in UTC.
 * Seconds and milliseconds appear only when there are any, as a browser
 * writes them.
 */
export function toDateTimeLocal(iso: string): string {
  const minutes = iso.slice(0, 16);
  const seconds = iso.slice(17, 19);
  const milliseconds = iso.slice(20, 23);
  if (milliseconds !== "000") return `${minutes}:${seconds}.${milliseconds}`;
  if (seconds !== "00") return `${minutes}:${seconds}`;
  return minutes;
}

/** The query string for `GET /v1/journeys`. */
export function journeysApiQuery(filters: JourneyFilters): string {
  const query = new URLSearchParams({ since: filters.since });
  // `readJourneyFilters` only ever sets an until after since; the API refuses
  // anything else, so this is the one place that would have to check again.
  if (filters.until !== "") query.set("until", filters.until);
  if (filters.status !== "") query.set("status", filters.status);
  if (filters.environment !== "") query.set("environment", filters.environment);
  if (filters.service !== "") query.set("service", filters.service);
  if (filters.entityType !== "") query.set("entityType", filters.entityType);
  if (filters.q !== "") query.set("q", filters.q);
  if (filters.minDurationMs !== "") query.set("minDurationMs", filters.minDurationMs);
  if (filters.minStepDurationMs !== "") query.set("minStepDurationMs", filters.minStepDurationMs);
  if (filters.inactiveBefore !== "") query.set("inactiveBefore", filters.inactiveBefore);
  if (filters.cursor !== "") query.set("cursor", filters.cursor);
  return query.toString();
}

/**
 * The link to the page after this one: every filter, the same range.
 *
 * Every filter, because a cursor holds only a position: a link that dropped
 * one would continue an unfiltered list from there.
 */
export function nextPageHref(filters: JourneyFilters, cursor: string): string {
  const query = filterQuery(filters);
  query.set("since", filters.since);
  if (filters.until !== "") query.set("until", filters.until);
  if (filters.inactiveBefore !== "") query.set("inactiveBefore", filters.inactiveBefore);
  query.set("cursor", cursor);
  return `/journeys?${query.toString()}`;
}

/**
 * The same filters from the newest journey. A preset starts again from now;
 * a custom range is the filter itself, so it stays.
 */
export function firstPageHref(filters: JourneyFilters): string {
  const query = filterQuery(filters);
  if (filters.window === "custom") {
    query.set("since", filters.since);
    if (filters.until !== "") query.set("until", filters.until);
  }
  return `/journeys?${query.toString()}`;
}

/** The same filters with another status, from the top: the Failures shortcut. */
export function statusHref(filters: JourneyFilters, status: JourneyStatusFilter): string {
  return firstPageHref({
    ...filters,
    status,
    ...(status === "active" ? {} : { inactiveForMs: "", inactiveBefore: "" })
  });
}

/** Each filter that is set, in words: `contains "acme"`, `status failed`. */
export function activeFilterList(filters: JourneyFilters): string[] {
  const parts: string[] = [];
  if (filters.q !== "") parts.push(`contains "${filters.q}"`);
  if (filters.status !== "") parts.push(`status ${filters.status}`);
  if (filters.entityType !== "") parts.push(`entity type ${filters.entityType}`);
  if (filters.environment !== "") parts.push(`environment ${filters.environment}`);
  if (filters.service !== "") parts.push(`service ${filters.service}`);
  if (filters.minDurationMs !== "") {
    parts.push(`recorded journey span over ${filters.minDurationMs} ms`);
  }
  if (filters.minStepDurationMs !== "") {
    parts.push(`a recorded step over ${filters.minStepDurationMs} ms`);
  }
  if (filters.inactiveForMs !== "") {
    parts.push(`active with no activity for at least ${filters.inactiveForMs} ms`);
  }
  parts.push(rangeWords(filters));
  return parts;
}

/**
 * What an empty list says. The page adds, beside it, what partial text can
 * match, because an identifier typed into Contains finds nothing.
 */
export function emptyListMessage(filters: JourneyFilters): string {
  if (filters.cursor !== "") return "No more journeys.";
  return `No journeys match: ${activeFilterList(filters).join(", ")}.`;
}

/** "Failed journeys in the last 24 hours, in production, containing "acme"". */
export function describeJourneyFilters(filters: JourneyFilters): string {
  const subject =
    filters.status === ""
      ? "Journeys"
      : `${filters.status.charAt(0).toUpperCase()}${filters.status.slice(1)} journeys`;
  const range = filters.window === "custom" ? rangeWords(filters) : `in ${rangeWords(filters)}`;
  const parts = [
    `${subject} ${range}`,
    filters.environment === "" ? "all environments" : `in ${filters.environment}`
  ];
  if (filters.entityType !== "") parts.push(`entity type ${filters.entityType}`);
  if (filters.service !== "") parts.push(`from ${filters.service}`);
  if (filters.q !== "") parts.push(`containing "${filters.q}"`);
  if (filters.minDurationMs !== "") parts.push(`recorded span over ${filters.minDurationMs} ms`);
  if (filters.minStepDurationMs !== "") parts.push(`a step over ${filters.minStepDurationMs} ms`);
  if (filters.inactiveForMs !== "") {
    parts.push(`inactive while active for at least ${filters.inactiveForMs} ms`);
  }
  return parts.join(", ");
}

/**
 * Where an old `/recent` link goes: the same query string on `/journeys`.
 *
 * The Recent page listed failures when no status was named, and its links and
 * bookmarks (the search page's "See recent failures" among them) relied on
 * that. The Journeys page defaults to any status, so a Recent link without a
 * status gains `status=failed` and still shows what it always showed. A named
 * status, including the empty "any", is kept as it came.
 */
export function recentRedirectHref(params: SearchParams): string {
  const query = new URLSearchParams(toQueryString(params));
  if (!query.has("status")) query.set("status", "failed");
  return `/journeys?${query.toString()}`;
}

/**
 * A page's search parameters written back as a query string, every value of
 * a repeated key kept in order, so a link that goes somewhere and comes back
 * (the project picker, a redirect) returns to the same page, notes and all.
 */
export function toQueryString(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) query.append(key, item);
  }
  return query.toString();
}

/** The query keys the Journeys page reads, and the only ones a way back keeps. */
const LIST_KEYS = new Set([
  "q",
  "status",
  "window",
  "entityType",
  "environment",
  "service",
  "minDurationMs",
  "minStepDurationMs",
  "inactiveForMs",
  "inactiveBefore",
  "since",
  "until",
  "cursor"
]);

/** What `from` says on a journey link made by the Journeys page. */
const FROM_JOURNEYS = "journeys";

/**
 * A row's link to its journey. It says the reader came from the Journeys page
 * and carries that page's query string, so the journey page can lead back to
 * the same list, filters, window and page.
 */
export function journeyHref(journeyId: string, listQuery: string): string {
  const query = new URLSearchParams({ from: FROM_JOURNEYS });
  if (listQuery !== "") query.set("list", listQuery);
  return `/journeys/${encodeURIComponent(journeyId)}?${query.toString()}`;
}

/**
 * Where the journey page's back link goes: the list a row link came from, or
 * Search, which is where every other way in starts.
 *
 * Both parameters arrive in the URL and anyone can edit them, so the result
 * is built rather than followed. `list` is only ever read as a query string:
 * it is parsed, kept to the Journeys page's own keys, and serialised again
 * after `/journeys?`, so no value of it can change the path or the origin,
 * and a key another page would act on (a `next`, say) is dropped.
 */
export function backFromJourney(params: SearchParams): { href: string; label: string } {
  if (params["from"] !== FROM_JOURNEYS) return { href: "/", label: "Search" };
  const raw = params["list"];
  const kept = new URLSearchParams();
  if (typeof raw === "string") {
    for (const [key, value] of new URLSearchParams(raw)) {
      if (LIST_KEYS.has(key)) kept.append(key, value);
    }
  }
  const query = kept.toString();
  return { href: query === "" ? "/journeys" : `/journeys?${query}`, label: "Journeys" };
}

/**
 * The query string without its empty values, or null when it has none.
 *
 * A plain GET form sends every field, so a search for one word produced an
 * address with seven empty parameters. `readJourneyFilters` reads an empty
 * value exactly as an absent one, so the page redirects to the address
 * without them: same list, an address worth sharing. Order and repeated
 * non-empty values are kept.
 */
export function withoutEmptyValues(params: SearchParams): string | null {
  let dropped = false;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) {
      if (item === "") dropped = true;
      else query.append(key, item);
    }
  }
  return dropped ? query.toString() : null;
}

/**
 * What the page says when the API refuses its query. With a cursor, the link
 * is a stale or edited next-page link, and the newest page is the way back.
 * Without one, the filters themselves were refused, which this module is meant
 * to prevent, so the reader is asked to change them in the form shown above.
 */
export function refusedListMessage(filters: JourneyFilters): {
  text: string;
  offerNewest: boolean;
} {
  return filters.cursor === ""
    ? { text: "The API refused these filters. Change them and show again.", offerNewest: false }
    : { text: "This page link is no longer valid.", offerNewest: true };
}

/** The filters that are set; an empty one reads the same as an absent one. */
function filterQuery(filters: JourneyFilters): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of [
    ["q", filters.q],
    ["status", filters.status],
    ["window", filters.window],
    ["entityType", filters.entityType],
    ["environment", filters.environment],
    ["service", filters.service],
    ["minDurationMs", filters.minDurationMs],
    ["minStepDurationMs", filters.minStepDurationMs],
    ["inactiveForMs", filters.inactiveForMs]
  ] as const) {
    if (value !== "") query.set(key, value);
  }
  return query;
}

/** A UI threshold that the API accepts, kept as canonical base-10 text. */
function milliseconds(raw: string | undefined, label: string, notes: string[]): string {
  if (raw === undefined || raw === "") return "";
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) > MAX_TIMING_MS) {
    notes.push(
      `${label} "${echo(raw)}" is not a whole number from 0 through ${String(MAX_TIMING_MS)} ms, so it was left out.`
    );
    return "";
  }
  return raw;
}

function rangeWords(filters: JourneyFilters): string {
  if (filters.window !== "custom") return `the ${JOURNEY_PRESETS[filters.window].label}`;
  const since = readable(filters.since);
  return filters.until === ""
    ? `since ${since} UTC`
    : `from ${since} to ${readable(filters.until)} UTC`;
}

/** `2026-09-10 08:00`, with seconds when there are any. */
export function readable(iso: string): string {
  return toDateTimeLocal(iso).replace("T", " ");
}

function presetSince(preset: JourneyPreset, now: Date): string {
  return new Date(now.getTime() - JOURNEY_PRESETS[preset].milliseconds).toISOString();
}

export type Range = { ok: true; since: string; until: string } | { ok: false; reason: string };

/**
 * A custom range from the form's two `datetime-local` inputs, read as UTC
 * because every time on the page is UTC, or from the instants a next-page
 * link carries. Checked against what the API refuses: a start in the future,
 * and an end that is not after the start.
 */
export function customRange(
  rawSince: string | undefined,
  rawUntil: string | undefined,
  now: Date
): Range {
  if (rawSince === undefined || rawSince === "") return { ok: false, reason: "choose a start" };
  const since = rangeInstant(rawSince);
  if (since === null) return { ok: false, reason: "the start is not a date and time" };
  if (Date.parse(since) > now.getTime()) {
    return { ok: false, reason: "the start is in the future" };
  }

  if (rawUntil === undefined || rawUntil === "") return { ok: true, since, until: "" };
  const until = rangeInstant(rawUntil);
  if (until === null) return { ok: false, reason: "the end is not a date and time" };
  if (Date.parse(until) <= Date.parse(since)) {
    return { ok: false, reason: "the end must be after the start" };
  }
  return { ok: true, since, until };
}

const DATETIME_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * The canonical instant for a `datetime-local` value in UTC, or for an
 * instant this page wrote; null for anything else. Written out in full and
 * compared after parsing, so an impossible date such as 30 February, which
 * `Date` would roll into March, is refused rather than moved.
 */
function rangeInstant(value: string): string | null {
  if (isOwnInstant(value, null)) return value;
  const match = DATETIME_LOCAL.exec(value);
  if (match === null) return null;
  const [, date, minutes, seconds = "00", fraction = ""] = match;
  const candidate = `${date ?? ""}T${minutes ?? ""}:${seconds}.${fraction.padEnd(3, "0")}Z`;
  const parsed = new Date(candidate);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === candidate ? candidate : null;
}

/**
 * Leaves out a text filter the API would refuse, with a note saying so.
 * `check` returns the note for a value outside the API's bounds.
 */
export function text(
  raw: string | undefined,
  name: string,
  notes: string[],
  check: (value: string) => string | null
): string {
  const value = raw?.trim() ?? "";
  if (value === "") return "";
  // PostgreSQL refuses a NUL in a comparison, so the API refuses it too.
  if (value.includes(String.fromCharCode(0))) {
    notes.push(`The ${name} filter held a character that cannot be searched, so it was left out.`);
    return "";
  }
  const note = check(value);
  if (note !== null) {
    notes.push(note);
    return "";
  }
  return value;
}

/** Restated from the API for the reason the bounds above are. */
function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * One value of `key`. A key given more than once is left out with a note:
 * guessing which value was meant could show a wider list than either.
 */
export function single(params: SearchParams, key: string, notes: string[]): string | undefined {
  const value = params[key];
  if (value === undefined || typeof value === "string") return value;
  notes.push(`${key} was given more than once, so it was left out.`);
  return undefined;
}

/** How much of an unrecognised value a note repeats. */
const ECHO_LENGTH = 32;

export function echo(value: string): string {
  const characters = Array.from(value);
  return characters.length <= ECHO_LENGTH ? value : `${characters.slice(0, ECHO_LENGTH).join("")}…`;
}

function isStatus(value: string): value is (typeof JOURNEY_STATUSES)[number] {
  return (JOURNEY_STATUSES as readonly string[]).includes(value);
}

function isPreset(value: string): value is JourneyPreset {
  return Object.hasOwn(JOURNEY_PRESETS, value);
}

/**
 * Whether `value` is an instant this page could have written: the canonical
 * ISO form with a four-digit year, and, when `now` is given, not later than
 * it. `toISOString` writes `+010000-…` for far-future years, which
 * round-trips but which the API refuses, and a future since is refused too;
 * either would leave the page with nothing to show but an error.
 */
function isOwnInstant(value: string, now: Date | null): boolean {
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    /^\d{4}-/.test(value) &&
    parsed.toISOString() === value &&
    (now === null || parsed.getTime() <= now.getTime())
  );
}
