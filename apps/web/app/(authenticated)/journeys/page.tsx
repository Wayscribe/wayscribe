import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import {
  ApiUnavailableError,
  InvalidPageLinkError,
  ProjectNotSelectedError,
  listJourneys,
  listProjects,
  type JourneyListPage
} from "../../../src/lib/api";
import { requireProjectId } from "../../../src/lib/current-project";
import {
  describeJourneyFilters,
  emptyListMessage,
  firstPageHref,
  journeysApiQuery,
  nextPageHref,
  readJourneyFilters,
  statusHref,
  type JourneyFilters
} from "../../../src/lib/journey-filters";
import { JourneyFilterBar } from "../../components/JourneyFilterBar";
import { JourneyRow } from "../../components/JourneyRow";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Journeys: browse what happened in a period, narrowed by status, type,
 * environment, service, or text remembered from a label or displayable alias.
 * The Recent page grew into this one; `/recent` redirects here.
 *
 * Rendered on the server from the URL alone, so a filtered view is a link.
 */
export default async function JourneysPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const params = await searchParams;
  const filters = readJourneyFilters(params, new Date());

  let environments: string[];
  let page: JourneyListPage;
  try {
    const projectId = await requireProjectId(`/journeys?${toQuery(params)}`);
    const [projects, listed] = await Promise.all([
      listProjects(),
      listJourneys(journeysApiQuery(filters), projectId)
    ]);
    environments = projects.find((project) => project.id === projectId)?.environments ?? [];
    page = listed;
  } catch (error) {
    if (error instanceof InvalidPageLinkError) {
      // A stale or edited link: a cursor or query the API refused. The API is
      // fine, so say what is wrong and offer the same filters from the top.
      return (
        <Shell filters={filters}>
          <p className="error">
            This page link is no longer valid.{" "}
            <Link href={firstPageHref(filters)}>Back to the newest</Link>
          </p>
        </Shell>
      );
    }
    if (error instanceof ApiUnavailableError) {
      return (
        <Shell filters={filters}>
          <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>
        </Shell>
      );
    }
    if (error instanceof ProjectNotSelectedError) {
      return (
        <Shell filters={filters}>
          <p className="error">
            The selected project is no longer available. <a href="/projects">Choose another</a>.
          </p>
        </Shell>
      );
    }
    throw error;
  }

  return (
    <Shell filters={filters}>
      <JourneyFilterBar filters={filters} environments={environments} />

      {filters.notes.length === 0 ? null : (
        <ul className="notice filter-notes" role="status">
          {filters.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {page.items.length === 0 ? (
        <>
          <p className="journeys-summary">{describeJourneyFilters(filters)}</p>
          <div className="empty-state">
            <p>{emptyListMessage(filters)}</p>
            {filters.cursor !== "" ? null : (
              <p className="muted">
                Contains finds partial text in journey labels and displayable alias values only. To
                find a record by an identifier, use <Link href="/">Search</Link>, which matches the
                whole value.
              </p>
            )}
          </div>
        </>
      ) : (
        <table className="journey-table">
          <caption className="journeys-summary">{describeJourneyFilters(filters)}</caption>
          <thead>
            <tr>
              <th scope="col" className="col-activity">
                Last activity
              </th>
              <th scope="col" className="col-status">
                Status
              </th>
              <th scope="col" className="col-type">
                Entity type
              </th>
              <th scope="col" className="col-shown">
                Shown as
              </th>
              <th scope="col" className="col-step">
                Last step
              </th>
              <th scope="col" className="col-events">
                Events
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <JourneyRow key={item.journeyId} item={item} />
            ))}
          </tbody>
        </table>
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

function Shell({
  filters,
  children
}: {
  filters: JourneyFilters;
  children: ReactNode;
}): ReactElement {
  return (
    <main>
      <header className="page-heading">
        <h1>Journeys</h1>
        <nav className="shortcuts" aria-label="Status shortcuts">
          <Link
            href={statusHref(filters, "")}
            aria-current={filters.status === "" ? "true" : undefined}
          >
            All
          </Link>
          <Link
            href={statusHref(filters, "failed")}
            aria-current={filters.status === "failed" ? "true" : undefined}
          >
            Failures
          </Link>
        </nav>
      </header>
      <p className="muted">All times UTC. Newest activity first.</p>
      {children}
    </main>
  );
}

function toQuery(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.append(key, value);
  }
  return query.toString();
}
