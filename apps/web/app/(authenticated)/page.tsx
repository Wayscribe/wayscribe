import Link from "next/link";
import { ApiUnavailableError, ProjectNotSelectedError, search } from "../../src/lib/api";
import { requireProjectId } from "../../src/lib/current-project";

export default async function SearchPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  return (
    <main>
      <h1>Find a record</h1>
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
  const projectId = await requireProjectId();

  let items;
  try {
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
        <li key={item.journeyId}>
          <Link href={`/journeys/${item.journeyId}`} className="mono">
            {item.entity.type}: {item.entity.id ?? "—"}
          </Link>
          <span className={item.status === "failed" ? "status failed" : "status"}>
            {item.status}
          </span>
          <span className="muted">
            {item.eventCount} events · last activity{" "}
            {item.lastEventAt.slice(0, 19).replace("T", " ")}
          </span>
        </li>
      ))}
    </ul>
  );
}
