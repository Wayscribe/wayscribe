import type { CliConfig } from "./config.js";

/**
 * A failure the user can act on.
 *
 * The API answers with `{error: {code, message, requestId}}`, and the codes are
 * specific enough to be worth translating — `project_required` means "pass
 * --project", not "something went wrong".
 */
export class ApiError extends Error {
  public override readonly name = "ApiError";
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
  }
}

export interface JourneySummary {
  journeyId: string;
  entity: { type: string; id: string };
  status: string;
  eventCount: number;
  startedAt: string;
  lastEventAt: string;
}

export interface JourneyDetail extends JourneySummary {
  /** `displayValue` arrives masked — the API never returns a full alias in a listing. */
  aliases: { type: string; displayValue: string }[];
  services: string[];
  completedAt: string | null;
}

export interface EventSummary {
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
  kind: string;
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface EventDetail extends EventSummary {
  journeyId: string;
  inputPayload?: unknown;
  outputPayload?: unknown;
  payloadDiff?: { changes: DiffChange[] } | null;
  error?: { message: string; type?: string; code?: string } | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class Client {
  public constructor(private readonly config: CliConfig) {}

  public projects(): Promise<Page<Project>> {
    return this.get<Page<Project>>("/v1/projects");
  }

  public search(query: string, limit: number): Promise<Page<JourneySummary>> {
    return this.get<Page<JourneySummary>>(
      `/v1/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`
    );
  }

  public journey(journeyId: string): Promise<JourneyDetail> {
    return this.get<JourneyDetail>(`/v1/journeys/${encodeURIComponent(journeyId)}`);
  }

  public event(eventId: string): Promise<EventDetail> {
    return this.get<EventDetail>(`/v1/events/${encodeURIComponent(eventId)}`);
  }

  /**
   * Every event of a journey, following cursors.
   *
   * A timeline that silently stopped at the first page would be worse than one
   * that refused: the whole point is seeing where a record ended up, and the
   * end is the part that gets truncated.
   */
  public async events(journeyId: string, maxPages = 20): Promise<EventSummary[]> {
    const all: EventSummary[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
      const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const next: Page<EventSummary> = await this.get<Page<EventSummary>>(
        `/v1/journeys/${encodeURIComponent(journeyId)}/events?limit=100${suffix}`
      );
      all.push(...next.items);
      if (next.nextCursor === null) return all;
      cursor = next.nextCursor;
    }
    return all;
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.token}` };
    if (this.config.projectId !== undefined) {
      headers["x-flight-project-id"] = this.config.projectId;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.url}${path}`, { headers });
    } catch {
      // A refused connection is the single most common first-run failure, and
      // "fetch failed" tells nobody anything.
      throw new ApiError(
        `Cannot reach ${this.config.url}. Is the API running, and is the URL right?`,
        0,
        "unreachable"
      );
    }

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        explain(response.status, error?.code, error?.message),
        response.status,
        error?.code ?? "unknown"
      );
    }

    return (body as { data: T }).data;
  }
}

/** The API's message, plus what to do about it when that is not obvious. */
function explain(status: number, code: string | undefined, message: string | undefined): string {
  const said = message ?? `Request failed with ${String(status)}.`;

  if (code === "unauthorized") {
    return `${said}\nCheck FLIGHT_RECORDER_TOKEN — it is the same value the web interface asks for.`;
  }
  if (code === "project_required" || code === "project_not_found") {
    return `${said}\nAn admin token spans projects, so name one: --project <id>, or FLIGHT_RECORDER_PROJECT.\nRun \`flight-recorder projects\` to list them.`;
  }
  if (status === 404) {
    return `${said}\nA record outside your key's project or environment reads as absent, which is deliberate.`;
  }
  return said;
}
