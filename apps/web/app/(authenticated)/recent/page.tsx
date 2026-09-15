import Link from "next/link";
import type { ReactNode } from "react";
import {
  ApiUnavailableError,
  ProjectNotSelectedError,
  listProjects,
  listRecentJourneys,
  type RecentPage
} from "../../../src/lib/api";
import { requireProjectId } from "../../../src/lib/current-project";
import {
  RECENT_STATUSES,
  RECENT_WINDOWS,
  describeRecentFilters,
  firstPageHref,
  nextPageHref,
  readRecentFilters,
  recentJourneysQuery,
  type RecentFilters
} from "../../../src/lib/recent-filters";
import { JourneyRow } from "../../components/JourneyRow";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Recent journeys, for an investigation that starts from "what failed" rather
 * than from an identifier.
 *
 * A plain GET form rendered on the server: no client state, so it works
 * without JavaScript and a filtered view is a URL someone can paste.
 */
export default async function RecentPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readRecentFilters(params, new Date());

  let projectId: string;
  let environments: string[];
  let page: RecentPage;
  try {
    projectId = await requireProjectId(
      `/recent?${new URLSearchParams(flatten(params)).toString()}`
    );
    const [projects, listed] = await Promise.all([
      listProjects(),
      listRecentJourneys(recentJourneysQuery(filters), projectId)
    ]);
    environments = projects.find((project) => project.id === projectId)?.environments ?? [];
    page = listed;
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return (
        <Shell>
          <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>
        </Shell>
      );
    }
    if (error instanceof ProjectNotSelectedError) {
      return (
        <Shell>
          <p className="error">
            The selected project is no longer available. <a href="/projects">Choose another</a>.
          </p>
        </Shell>
      );
    }
    throw error;
  }

  const description = describeRecentFilters(filters);

  return (
    <Shell>
      <Filters filters={filters} environments={environments} />

      <p className="recent-summary">{description}</p>

      {page.items.length === 0 ? (
        <p className="muted">
          {filters.cursor === "" ? "Nothing here. " : "No more journeys. "}
          Widen the window or choose any status to see more.
        </p>
      ) : (
        <ul className="results">
          {page.items.map((item) => (
            <JourneyRow key={item.journeyId} item={item} environment={item.environment} />
          ))}
        </ul>
      )}

      {page.nextCursor === null && filters.cursor === "" ? null : (
        <p className="muted pager">
          {page.nextCursor === null ? null : (
            <>
              Showing {page.items.length} journeys.{" "}
              <Link href={nextPageHref(filters, page.nextCursor)}>Next page</Link>
            </>
          )}{" "}
          {filters.cursor === "" ? null : (
            <Link href={firstPageHref(filters)}>Back to the newest</Link>
          )}
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main>
      <header className="page-heading">
        <h1>Recent journeys</h1>
        <Link href="/">Search by identifier</Link>
      </header>
      {children}
    </main>
  );
}

function Filters({ filters, environments }: { filters: RecentFilters; environments: string[] }) {
  // A shared URL can name an environment this project no longer lists; keep it
  // selectable so the form reflects the list it produced.
  const environmentOptions =
    filters.environment === "" || environments.includes(filters.environment)
      ? environments
      : [...environments, filters.environment];

  return (
    <form method="get" action="/recent" className="recent-filters">
      <label>
        <span className="label">Status</span>
        <select name="status" defaultValue={filters.status}>
          {RECENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
          <option value="">any</option>
        </select>
      </label>
      <label>
        <span className="label">Window</span>
        <select name="window" defaultValue={filters.window}>
          {Object.entries(RECENT_WINDOWS).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Environment</span>
        <select name="environment" defaultValue={filters.environment}>
          <option value="">all</option>
          {environmentOptions.map((environment) => (
            <option key={environment} value={environment}>
              {environment}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Service</span>
        <input name="service" defaultValue={filters.service} placeholder="any" />
      </label>
      <button type="submit">Show</button>
    </form>
  );
}

function flatten(params: SearchParams): [string, string][] {
  return Object.entries(params).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value] as [string, string]] : []
  );
}
