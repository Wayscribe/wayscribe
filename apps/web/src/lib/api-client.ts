/**
 * Fetches the browser makes against this app's own `/api` routes.
 *
 * Deliberately not in `api.ts`: that module reads `ADMIN_TOKEN` and talks to
 * the API directly, so it must never be pulled into the client bundle. These
 * helpers run inside the client component tree and carry no secret.
 */

export type Fetched<T> =
  | { kind: "ok"; body: T }
  | {
      kind: "failed";
      /**
       * A 401 or 409: the session is gone, or no project can be resolved for
       * it. Both route handlers answer that way, and neither is cured by
       * asking again, so a caller stops rather than counting it as a blip and
       * retrying. Every other failure is temporary by assumption.
       */
      permanent: boolean;
    };

/** One page of a journey's events, from `cursor` when there is one. */
export function eventsUrl(journeyId: string, cursor: string | null): string {
  const base = `/api/journeys/${encodeURIComponent(journeyId)}/events`;
  return cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

/** Never throws: a non-2xx, a network error, and a non-JSON body are all failures. */
export async function fetchJson<T>(url: string): Promise<Fetched<T>> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return { kind: "failed", permanent: response.status === 401 || response.status === 409 };
    }
    return { kind: "ok", body: (await response.json()) as T };
  } catch {
    return { kind: "failed", permanent: false };
  }
}
