import { webConfig } from "./config";

export interface SearchItem {
  journeyId: string;
  entity: { type: string; id: string | null };
  status: string;
  eventCount: number;
  startedAt: string;
  lastEventAt: string;
}

export interface JourneyDetail {
  journeyId: string;
  entity: { type: string; id: string | null };
  status: string;
  aliases: { type: string; displayValue: string | null }[];
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
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
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
  requestHeaders: Record<string, string>;
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
        ...(projectId === undefined || projectId === "" ? {} : { "x-flight-project-id": projectId })
      },
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Flight Recorder API is unreachable.", { cause });
  }

  if (response.status === 404) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    if (body.error?.code === "project_not_found") {
      throw new ProjectNotSelectedError("No project is selected.");
    }
    return null;
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

export const getJourney = (journeyId: string, projectId: string): Promise<JourneyDetail | null> =>
  get<JourneyDetail>(`/v1/journeys/${encodeURIComponent(journeyId)}`, projectId);

export async function listEvents(journeyId: string, projectId: string): Promise<EventListItem[]> {
  const data = await get<{ items: EventListItem[] }>(
    `/v1/journeys/${encodeURIComponent(journeyId)}/events?limit=100`,
    projectId
  );
  return data?.items ?? [];
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
        ...(projectId === "" ? {} : { "x-flight-project-id": projectId })
      },
      body: JSON.stringify(body),
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Flight Recorder API is unreachable.", { cause });
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
