import Link from "next/link";
import type { SearchItem } from "../../src/lib/api";

/**
 * One journey in a list: search results and the Recent page.
 *
 * Shared so the two lists read the same way. `environment` is optional because
 * search is already scoped and never spans environments in a way a reader
 * needs named; the Recent list does.
 */
export function JourneyRow({ item, environment }: { item: SearchItem; environment?: string }) {
  return (
    <li>
      <Link href={`/journeys/${encodeURIComponent(item.journeyId)}`} className="mono">
        {item.entity.type}: {item.entity.id ?? "—"}
      </Link>
      <span className={item.status === "failed" ? "status failed" : "status"}>{item.status}</span>
      {environment === undefined ? null : <span className="environment">{environment}</span>}
      <span className="muted">
        {item.eventCount} {item.eventCount === 1 ? "event" : "events"} · last activity{" "}
        {item.lastEventAt.slice(0, 19).replace("T", " ")}
      </span>
    </li>
  );
}
