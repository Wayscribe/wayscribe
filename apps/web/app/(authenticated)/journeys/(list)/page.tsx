import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import {
  ApiUnavailableError,
  InvalidPageLinkError,
  ProjectNotSelectedError,
  listJourneys,
  listProjects,
  type JourneyListPage
} from "../../../../src/lib/api";
import { requireProjectId } from "../../../../src/lib/current-project";
import {
  describeJourneyFilters,
  emptyListMessage,
  firstPageHref,
  journeysApiQuery,
  nextPageHref,
  readJourneyFilters,
  refusedListMessage,
  statusHref,
  toQueryString,
  withoutEmptyValues,
  type JourneyFilters
} from "../../../../src/lib/journey-filters";
import { JourneyFilterBar } from "../../../components/JourneyFilterBar";
import { JourneyTable } from "../../../components/JourneyTable";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Journeys: browse what happened in a period, narrowed by status, type,
 * environment, service, or text remembered from a label or displayable alias.
 * The Recent page grew into this one; `/recent` redirects here.
 *
 * Rendered on the server from the URL alone, so a filtered view is a link.
 *
 * In the `(list)` route group so its loading state covers this page and not
 * the journey pages beside it (`loading.tsx` says why).
 */
export default async function JourneysPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const params = await searchParams;
  const cleaned = withoutEmptyValues(params);
  if (cleaned !== null) redirect(cleaned === "" ? "/journeys" : `/journeys?${cleaned}`);
  const filters = readJourneyFilters(params, new Date());

  let environments: string[] = [];
  let page: JourneyListPage;
  try {
    // Every value of a repeated key is kept, so the page the picker returns
    // to reads the same parameters and shows the same notes.
    const projectId = await requireProjectId(`/journeys?${toQueryString(params)}`);
    // Settled separately, so a refused list still has the environments for
    // the form that lets the reader change what was refused.
    const [projects, listed] = await Promise.allSettled([
      listProjects(),
      listJourneys(journeysApiQuery(filters), projectId)
    ]);
    if (projects.status === "fulfilled") {
      environments = projects.value.find((project) => project.id === projectId)?.environments ?? [];
    }
    if (listed.status === "rejected") throw listed.reason;
    if (projects.status === "rejected") throw projects.reason;
    page = listed.value;
  } catch (error) {
    if (error instanceof InvalidPageLinkError) {
      // The API is fine and refused this query: a stale or edited next-page
      // link, or filters this page should not have sent. Say which, and give
      // the reader a way on.
      const refused = refusedListMessage(filters);
      return (
        <Shell filters={filters}>
          {refused.offerNewest ? null : (
            <JourneyFilterBar filters={filters} environments={environments} />
          )}
          <p className="error">
            {refused.text}
            {refused.offerNewest ? (
              <>
                {" "}
                <Link href={firstPageHref(filters)}>Back to the newest</Link>
              </>
            ) : null}
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
        // The role sits on a wrapper: on the list itself it would replace the
        // list role, and a screen reader would stop announcing it as a list.
        <div role="status">
          <ul className="notice filter-notes">
            {filters.notes.map((note, index) => (
              <li key={`${String(index)}-${note}`}>{note}</li>
            ))}
          </ul>
        </div>
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
        <JourneyTable filters={filters} items={page.items} listQuery={toQueryString(params)} />
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
