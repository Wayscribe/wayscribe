import { webConfig } from "./config";

export interface SearchItem {
  journeyId: string;
  entity: { type: string; id: string | null };
  status: string;
  eventCount: number;
  startedAt: string;
  lastEventAt: string;
  /** Public display text the instrumenting code set, or null. */
  label: string | null;
  /** The step name of the latest event, or null for a journey recorded before it was kept. */
  lastStep: string | null;
  /** Only aliases marked displayable (ADR-053), in alias-type order, in plain text. */
  displayableAliases: { type: string; value: string }[];
}

export interface JourneyDetail {
  journeyId: string;
  environment: string;
  entity: { type: string; id: string | null };
  status: string;
  /** Public display text the instrumenting code set, or null. An older API omits it. */
  label?: string | null;
  /**
   * `displayValue` is masked unless `displayable` is true. An API that
   * predates the flag omits it, and its values are masked.
   */
  aliases: { type: string; displayValue: string | null; displayable?: boolean }[];
  services: string[];
  eventCount: number;
  startedAt: string;
  completedAt: string | null;
  lastEventAt: string;
}

export interface EventListItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: string;
  /** Server-side arrival. The only thing that can expose a wrong service clock. */
  receivedAt: string;
  durationMs: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  hasError: boolean;
}

export interface DiffChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface EventDetailData extends EventListItem {
  journeyId: string;
  receivedAt: string;
  traceId: string | null;
  messageId: string | null;
  inputPayload: unknown;
  outputPayload: unknown;
  payloadDiff: { changes: DiffChange[]; truncated: boolean } | null;
  error: unknown;
  /**
   * What the instrumented code attached, as stored: `metadata`, `deployment`
   * and `runtime` on the event it sent. Untrusted text of any shape, so it is
   * shown only through `metadataEntries`. Optional so a test fixture, or a
   * different API, may leave them out.
   */
  customMetadata?: unknown;
  deploymentMetadata?: unknown;
  runtimeMetadata?: unknown;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  /** Environment names, sorted. */
  environments: string[];
}

export interface ReplayDestination {
  id: string;
  name: string;
  baseUrl: string;
  environmentType: string;
  enabled: boolean;
}

export interface ReplayRun {
  id: string;
  eventId: string;
  method: string;
  path: string;
  requestPayload: unknown;
  /** Names as sent; a destination header's value is always `[REDACTED]`. */
  requestHeaders: Record<string, string> | null;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  responseStatus: number | null;
  responsePayload: unknown;
  durationMs: number | null;
  error: { reason?: string; message?: string } | null;
  comparison: { changes: DiffChange[]; truncated: boolean } | null;
}

export class ApiUnavailableError extends Error {
  public override readonly name = "ApiUnavailableError";
}

/**
 * The API refused the query or cursor a page link carried.
 *
 * A stale or hand-edited link, not an outage. Reporting it as "cannot reach
 * the API" sent people to check an API that was running and answering.
 */
export class InvalidPageLinkError extends Error {
  public override readonly name = "InvalidPageLinkError";
}

/** Error codes that mean the request's own query string was refused. */
const PAGE_LINK_ERROR_CODES = new Set(["invalid_cursor", "invalid_query"]);

/**
 * The API could not tell which project to read from.
 *
 * Distinct from "not found", and the distinction is the whole point. A journey
 * that does not exist and an installation that cannot decide which project to
 * search are different answers, and collapsing them into an empty result set
 * renders a working stack as "Nothing matched" — which reads as a broken
 * product rather than a missing selection.
 */
export class ProjectNotSelectedError extends Error {
  public override readonly name = "ProjectNotSelectedError";
}

/**
 * The only module that knows the API contract.
 *
 * Runs server-side exclusively — the admin token is project-wide and must never
 * reach the browser (ADR-029). `cache: "no-store"` because a debugging tool
 * showing stale data is worse than one that is slightly slower.
 */
async function get<T>(path: string, projectId?: string): Promise<T | null> {
  const config = webConfig();
  let response: Response;
  try {
    response = await fetch(`${config.API_URL}${path}`, {
      headers: {
        authorization: `Bearer ${config.ADMIN_TOKEN}`,
        // An admin token reads one named project. Omitted, the API falls back to
        // "the only project", which stops resolving the moment a second exists.
        ...(projectId === undefined || projectId === ""
          ? {}
          : { "x-wayscribe-project-id": projectId })
      },
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Wayscribe API is unreachable.", { cause });
  }

  if (response.status === 404) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    if (body.error?.code === "project_not_found") {
      throw new ProjectNotSelectedError("No project is selected.");
    }
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    // A token mismatch is a configuration problem with a specific fix, not an
    // outage. Collapsing it into "unreachable" sent people to check whether the
    // API was running when it was running and refusing them.
    throw new ApiUnavailableError(
      "The API rejected this request. The web and API containers may hold different ADMIN_TOKEN values."
    );
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    if (PAGE_LINK_ERROR_CODES.has(body.error?.code ?? "")) {
      throw new InvalidPageLinkError("The API refused this page's query.");
    }
  }
  if (!response.ok) {
    throw new ApiUnavailableError(`API responded ${String(response.status)}.`);
  }

  const body = (await response.json()) as { data: T };
  return body.data;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await get<{ items: ProjectSummary[] }>("/v1/projects");
  return data?.items ?? [];
}

export async function search(query: string, projectId: string): Promise<SearchItem[]> {
  const data = await get<{ items: SearchItem[] }>(
    `/v1/search?q=${encodeURIComponent(query)}`,
    projectId
  );
  return data?.items ?? [];
}

export interface JourneyListRow extends SearchItem {
  environment: string;
}

export interface JourneyListPage {
  items: JourneyListRow[];
  nextCursor: string | null;
}

/**
 * One page of the journey list. `query` comes from `journeysApiQuery`, which
 * owns what the Journeys page's filters mean.
 */
export async function listJourneys(query: string, projectId: string): Promise<JourneyListPage> {
  const data = await get<JourneyListPage>(`/v1/journeys?${query}`, projectId);
  return data ?? { items: [], nextCursor: null };
}

export const getJourney = (journeyId: string, projectId: string): Promise<JourneyDetail | null> =>
  get<JourneyDetail>(`/v1/journeys/${encodeURIComponent(journeyId)}`, projectId);

export interface EventsPage {
  items: EventListItem[];
  nextCursor: string | null;
}

/** What the timeline component reads on every poll and every load-more. */
export interface EventsPageResponse extends EventsPage {
  journeyStatus: string;
  journeyEventCount: number;
}

/**
 * One page of a journey's events.
 *
 * The API paginates at 100. This used to loop over up to six pages to hide the
 * cap from the server-rendered page; the timeline component now owns
 * pagination and follows the cursor on demand, so the server fetches the first
 * page and hands the cursor over.
 */
export function listEvents(
  journeyId: string,
  projectId: string,
  cursor: string | null = null
): Promise<EventsPage | null> {
  const query = new URLSearchParams({ limit: "100" });
  if (cursor !== null) query.set("cursor", cursor);
  return get<EventsPage>(
    `/v1/journeys/${encodeURIComponent(journeyId)}/events?${query.toString()}`,
    projectId
  );
}

export const getEvent = (eventId: string, projectId: string): Promise<EventDetailData | null> =>
  get<EventDetailData>(`/v1/events/${encodeURIComponent(eventId)}`, projectId);

/**
 * The one write path in this application.
 *
 * Server-side like every other call here: the admin token is project-wide and
 * must never reach the browser (ADR-029). A 4xx is returned rather than thrown,
 * because a refused replay is a result the operator needs to read, not an error
 * page — the whole point of the safety checks is that the reason is visible.
 */
export interface PostResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: { code: string; message: string };
}

async function post(path: string, body: unknown, projectId: string): Promise<PostResult<unknown>> {
  const config = webConfig();
  let response: Response;
  try {
    response = await fetch(`${config.API_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ADMIN_TOKEN}`,
        "content-type": "application/json",
        ...(projectId === "" ? {} : { "x-wayscribe-project-id": projectId })
      },
      body: JSON.stringify(body),
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Wayscribe API is unreachable.", { cause });
  }

  const parsed = (await response.json().catch(() => ({}))) as {
    data?: unknown;
    error?: { code: string; message: string };
  };

  return {
    ok: response.ok,
    status: response.status,
    data: parsed.data ?? null,
    ...(parsed.error === undefined ? {} : { error: parsed.error })
  };
}

export async function listReplayDestinations(projectId: string): Promise<ReplayDestination[]> {
  const data = await get<{ items: ReplayDestination[] }>("/v1/replay-destinations", projectId);
  return data?.items ?? [];
}

export const createReplay = (
  input: { eventId: string; destinationId: string; path: string; method: string },
  projectId: string
): Promise<PostResult<ReplayRun>> =>
  // The API's shape for this route is known; `post` deliberately does not
  // pretend to know it, so the narrowing happens once, here.
  post("/v1/replays", input, projectId) as Promise<PostResult<ReplayRun>>;

export const getReplay = (replayId: string, projectId: string): Promise<ReplayRun | null> =>
  get<ReplayRun>(`/v1/replays/${encodeURIComponent(replayId)}`, projectId);

/**
 * Delete one journey, its events, aliases, and replay runs.
 *
 * Resolves to what happened rather than throwing for a journey that is not
 * there: an operator who confirms twice, or in two tabs, finds it already gone,
 * which is not an outage. Failures the operator cannot fix by retrying throw
 * the same typed errors as a read.
 */
export async function deleteJourney(
  journeyId: string,
  projectId: string
): Promise<"deleted" | "not_found"> {
  const config = webConfig();
  let response: Response;
  try {
    response = await fetch(`${config.API_URL}/v1/journeys/${encodeURIComponent(journeyId)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${config.ADMIN_TOKEN}`,
        ...(projectId === "" ? {} : { "x-wayscribe-project-id": projectId })
      },
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Wayscribe API is unreachable.", { cause });
  }

  if (response.status === 204) return "deleted";
  if (response.status === 404) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    if (body.error?.code === "project_not_found") {
      throw new ProjectNotSelectedError("No project is selected.");
    }
    return "not_found";
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiUnavailableError(
      "The API rejected this request. The web and API containers may hold different ADMIN_TOKEN values."
    );
  }
  throw new ApiUnavailableError(`API responded ${String(response.status)}.`);
}
