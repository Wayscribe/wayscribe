/**
 * The Recent page's filters, read from its URL.
 *
 * The page is a plain GET form, so everything here arrives as query-string
 * text a person can edit. Unknown values fall back to the defaults rather than
 * erroring: a hand-edited URL should still show a sensible page, and the API
 * would otherwise refuse the request and the page could only say so.
 */

export const RECENT_STATUSES = ["failed", "active", "completed"] as const;
/** An empty string is "any status": what the form's first option sends. */
export type RecentStatus = (typeof RECENT_STATUSES)[number] | "";

export const RECENT_WINDOWS = {
  "1h": { label: "last hour", milliseconds: 60 * 60 * 1000 },
  "24h": { label: "last 24 hours", milliseconds: 24 * 60 * 60 * 1000 },
  "7d": { label: "last 7 days", milliseconds: 7 * 24 * 60 * 60 * 1000 }
} as const;
export type RecentWindow = keyof typeof RECENT_WINDOWS;

export interface RecentFilters {
  status: RecentStatus;
  window: RecentWindow;
  /** Empty means every environment. */
  environment: string;
  /** Empty means any service. */
  service: string;
  /** The instant the list starts from, ISO-8601. */
  since: string;
  /** Empty on the first page. */
  cursor: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

export function readRecentFilters(params: SearchParams, now: Date): RecentFilters {
  const rawStatus = single(params["status"]);
  const status: RecentStatus =
    rawStatus === undefined
      ? "failed"
      : rawStatus === "" || isStatus(rawStatus)
        ? rawStatus
        : "failed";

  const rawWindow = single(params["window"]);
  const window: RecentWindow = rawWindow !== undefined && isWindow(rawWindow) ? rawWindow : "24h";

  // A next-page link carries the since its first page used. Recomputing it from
  // the window would slide the list under the cursor between pages. It is
  // honoured only beside a cursor, because that is the only link that carries
  // one: a bare `?since=2000-…&window=1h` would otherwise list years of
  // journeys under "in the last hour". Anything that is not an instant this
  // function could have written is recomputed too.
  const cursor = single(params["cursor"]) ?? "";
  const carried = single(params["since"]);
  const since =
    cursor !== "" && carried !== undefined && isOwnInstant(carried, now)
      ? carried
      : new Date(now.getTime() - RECENT_WINDOWS[window].milliseconds).toISOString();

  return {
    status,
    window,
    environment: single(params["environment"])?.trim() ?? "",
    service: single(params["service"])?.trim() ?? "",
    since,
    cursor
  };
}

/** What an empty list says, suggesting only the widenings still available. */
export function emptyListMessage(filters: RecentFilters): string {
  if (filters.cursor !== "") return "No more journeys.";

  const canWiden = filters.window !== "7d";
  const canChooseAny = filters.status !== "";
  if (canWiden && canChooseAny) {
    return "Nothing here. Widen the window or choose any status to see more.";
  }
  if (canWiden) return "Nothing here. Widen the window to see more.";
  if (canChooseAny) return "Nothing here. Choose any status to see more.";
  return "Nothing here.";
}

/** The query string for `GET /v1/journeys`. */
export function recentJourneysQuery(filters: RecentFilters): string {
  const query = new URLSearchParams({ since: filters.since });
  if (filters.status !== "") query.set("status", filters.status);
  if (filters.environment !== "") query.set("environment", filters.environment);
  if (filters.service !== "") query.set("service", filters.service);
  if (filters.cursor !== "") query.set("cursor", filters.cursor);
  return query.toString();
}

/** The link to the page after this one: same filters, same since. */
export function nextPageHref(filters: RecentFilters, cursor: string): string {
  const query = new URLSearchParams({
    status: filters.status,
    window: filters.window,
    environment: filters.environment,
    service: filters.service,
    since: filters.since,
    cursor
  });
  return `/recent?${query.toString()}`;
}

/** The same filters from the newest journey, with a fresh window. */
export function firstPageHref(filters: RecentFilters): string {
  const query = new URLSearchParams({
    status: filters.status,
    window: filters.window,
    environment: filters.environment,
    service: filters.service
  });
  return `/recent?${query.toString()}`;
}

/** "Failed journeys in the last 24 hours, all environments". */
export function describeRecentFilters(filters: RecentFilters): string {
  const subject =
    filters.status === ""
      ? "Journeys"
      : `${filters.status.charAt(0).toUpperCase()}${filters.status.slice(1)} journeys`;
  const parts = [
    `${subject} in the ${RECENT_WINDOWS[filters.window].label}`,
    filters.environment === "" ? "all environments" : `in ${filters.environment}`
  ];
  if (filters.service !== "") parts.push(`from ${filters.service}`);
  return parts.join(", ");
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isStatus(value: string): value is (typeof RECENT_STATUSES)[number] {
  return (RECENT_STATUSES as readonly string[]).includes(value);
}

function isWindow(value: string): value is RecentWindow {
  return Object.hasOwn(RECENT_WINDOWS, value);
}

/**
 * Whether `value` is an instant this page could have written: the canonical
 * ISO form with a four-digit year, and not later than now. `toISOString`
 * writes `+010000-…` for far-future years, which round-trips but which the
 * API refuses, and a future since is refused too; either would leave the page
 * with nothing to show but an error.
 */
function isOwnInstant(value: string, now: Date): boolean {
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    /^\d{4}-/.test(value) &&
    parsed.toISOString() === value &&
    parsed.getTime() <= now.getTime()
  );
}
