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

export class ApiUnavailableError extends Error {
  public override readonly name = "ApiUnavailableError";
}

/**
 * The only module that knows the API contract.
 *
 * Runs server-side exclusively — the admin token is project-wide and must never
 * reach the browser (ADR-029). `cache: "no-store"` because a debugging tool
 * showing stale data is worse than one that is slightly slower.
 */
async function get<T>(path: string): Promise<T | null> {
  const config = webConfig();
  let response: Response;
  try {
    response = await fetch(`${config.API_URL}${path}`, {
      headers: { authorization: `Bearer ${config.ADMIN_TOKEN}` },
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Flight Recorder API is unreachable.", { cause });
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ApiUnavailableError(`API responded ${String(response.status)}.`);
  }

  const body = (await response.json()) as { data: T };
  return body.data;
}

export async function search(query: string): Promise<SearchItem[]> {
  const data = await get<{ items: SearchItem[] }>(`/v1/search?q=${encodeURIComponent(query)}`);
  return data?.items ?? [];
}

export const getJourney = (journeyId: string): Promise<JourneyDetail | null> =>
  get<JourneyDetail>(`/v1/journeys/${encodeURIComponent(journeyId)}`);

export async function listEvents(journeyId: string): Promise<EventListItem[]> {
  const data = await get<{ items: EventListItem[] }>(
    `/v1/journeys/${encodeURIComponent(journeyId)}/events?limit=100`
  );
  return data?.items ?? [];
}

export const getEvent = (eventId: string): Promise<EventDetailData | null> =>
  get<EventDetailData>(`/v1/events/${encodeURIComponent(eventId)}`);
