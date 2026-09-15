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
  // the window would slide the list under the cursor between pages. Anything
  // that is not exactly what this function writes is recomputed instead.
  const carried = single(params["since"]);
  const since =
    carried !== undefined && isOwnInstant(carried)
      ? carried
      : new Date(now.getTime() - RECENT_WINDOWS[window].milliseconds).toISOString();

  return {
    status,
    window,
    environment: single(params["environment"])?.trim() ?? "",
    service: single(params["service"])?.trim() ?? "",
    since,
    cursor: single(params["cursor"]) ?? ""
  };
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

function isOwnInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
