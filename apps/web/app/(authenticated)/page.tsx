import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import {
  ApiUnavailableError,
  InvalidPageLinkError,
  ProjectNotSelectedError,
  listProjects,
  search,
  type SearchItem
} from "../../src/lib/api";
import { requireProjectId } from "../../src/lib/current-project";
import {
  toQueryString,
  withoutEmptyValues,
  type SearchParams
} from "../../src/lib/journey-filters";
import {
  describeSearchScope,
  readSearchFilters,
  searchApiQuery,
  type SearchFilters
} from "../../src/lib/search-filters";
import { JourneyListItem } from "../components/JourneyListItem";
import { SearchForm } from "../components/SearchForm";

/**
 * Search: find a record by an identifier, narrowed by time and environment
 * when the identifier recurs (F-036).
 *
 * Rendered on the server from the URL alone and not streamed, for the reasons
 * the Journeys page gives: it has to work without JavaScript, and a streamed
 * page reveals its content with a script.
 */
export default async function SearchPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const params = await searchParams;
  // A plain GET form sends every field, so a search for one identifier would
  // otherwise carry four empty parameters in its address.
  const cleaned = withoutEmptyValues(params);
  if (cleaned !== null) redirect(cleaned === "" ? "/" : `/?${cleaned}`);
  const filters = readSearchFilters(params, new Date());
  const deleted = typeof params["deleted"] === "string" ? params["deleted"] : undefined;

  let environments: string[] = [];
  let outcome: Outcome = { kind: "idle" };
  try {
    // Inside the try for the same reason as the journey page: this reaches the
    // API, and an unreachable API escaping here rendered a blank 500. Every
    // value of a repeated key is kept, so the page the picker returns to reads
    // the same parameters and shows the same notes.
    const projectId = await requireProjectId(`/?${toQueryString(params)}`);
    // Settled separately, so a refused search still has the environments for
    // the form that lets the reader change what was refused.
    const [projects, found] = await Promise.allSettled([
      listProjects(),
      filters.q === "" ? Promise.resolve(null) : search(searchApiQuery(filters), projectId)
    ]);
    if (projects.status === "fulfilled") {
      environments = projects.value.find((project) => project.id === projectId)?.environments ?? [];
    }
    if (found.status === "rejected") throw found.reason;
    if (found.value !== null) outcome = { kind: "found", items: found.value };
  } catch (error) {
    if (error instanceof ApiUnavailableError) outcome = { kind: "unavailable" };
    else if (error instanceof ProjectNotSelectedError) outcome = { kind: "no-project" };
    else if (error instanceof InvalidPageLinkError) outcome = { kind: "refused" };
    else throw error;
  }

  return (
    <main id="main">
      {deleted === undefined ? null : (
        // Set by the delete route handler, which only ever puts an entity type
        // here. React escapes it either way.
        <p className="notice" role="status">
          {deleted === "journey" ? "Deleted the journey." : `Deleted the ${deleted} journey.`} It no
          longer appears in search.
        </p>
      )}
      <header className="page-heading">
        <h1>Find a record</h1>
        <Link href="/journeys?status=failed">No identifier? See recent failures</Link>
      </header>
      <p className="muted">
        Search any identifier you have: a customer ID, an external reference, a trace or message ID.
        You do not need to know which system it came from.
      </p>

      <SearchForm filters={filters} environments={environments} />

      {filters.notes.length === 0 ? null : (
        <div role="status">
          <ul className="notice filter-notes">
            {filters.notes.map((note, index) => (
              <li key={`${String(index)}-${note}`}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <Results filters={filters} outcome={outcome} />
    </main>
  );
}

type Outcome =
  | { kind: "idle" }
  | { kind: "found"; items: SearchItem[] }
  | { kind: "unavailable" }
  | { kind: "no-project" }
  | { kind: "refused" };

function Results({ filters, outcome }: { filters: SearchFilters; outcome: Outcome }): ReactElement {
  switch (outcome.kind) {
    case "unavailable":
      return <p className="error">Cannot reach the Wayscribe API. Is it running?</p>;
    case "no-project":
      // The session names a project that no longer exists. Say so, rather
      // than reporting it as a record that does not exist.
      return (
        <p className="error">
          The selected project is no longer available. <a href="/projects">Choose another</a>.
        </p>
      );
    case "refused":
      return <p className="error">The API refused this search. Change it and search again.</p>;
    case "idle":
      return <p className="muted">Enter an identifier above to begin.</p>;
    case "found":
      break;
  }

  const scope = describeSearchScope(filters);
  if (outcome.items.length === 0) {
    return (
      <>
        {scope === null ? null : <p className="journeys-summary">{scope}</p>}
        <p className="muted">
          Nothing matched <span className="mono">{filters.q}</span>
          {scope === null ? "" : " here"}. Identifiers are matched exactly, so a partial value will
          not find a record.
        </p>
      </>
    );
  }

  return (
    <>
      {scope === null ? null : <p className="journeys-summary">{scope}</p>}
      <ul className="results">
        {outcome.items.map((item) => (
          <JourneyListItem key={item.journeyId} item={item} />
        ))}
      </ul>
    </>
  );
}
