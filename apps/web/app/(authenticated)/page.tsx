import Link from "next/link";
import { ApiUnavailableError, ProjectNotSelectedError, search } from "../../src/lib/api";
import { requireProjectId } from "../../src/lib/current-project";
import { JourneyListItem } from "../components/JourneyListItem";

export default async function SearchPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; deleted?: string }>;
}) {
  const { q, deleted } = await searchParams;
  const query = q?.trim() ?? "";

  return (
    <main>
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
        Search any identifier you have — a customer ID, an external reference, a trace or message
        ID. You do not need to know which system it came from.
      </p>

      <form method="get" className="search-row">
        <input name="q" defaultValue={query} placeholder="0018Z00002ABC" aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      {query === "" ? (
        <p className="muted">Enter an identifier above to begin.</p>
      ) : (
        <Results query={query} />
      )}
    </main>
  );
}

async function Results({ query }: { query: string }) {
  let items;
  try {
    // Inside the try for the same reason as the journey page: this reaches the
    // API, and an unreachable API escaping here rendered a blank 500.
    const projectId = await requireProjectId(`/?q=${encodeURIComponent(query)}`);
    items = await search(query, projectId);
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    if (error instanceof ProjectNotSelectedError) {
      // The session names a project that no longer exists. Say so, rather
      // than reporting it as a record that does not exist.
      return (
        <p className="error">
          The selected project is no longer available. <a href="/projects">Choose another</a>.
        </p>
      );
    }
    throw error;
  }

  if (items.length === 0) {
    return (
      <p className="muted">
        Nothing matched <span className="mono">{query}</span>. Identifiers are matched exactly, so a
        partial value will not find a record.
      </p>
    );
  }

  return (
    <ul className="results">
      {items.map((item) => (
        <JourneyListItem key={item.journeyId} item={item} />
      ))}
    </ul>
  );
}
