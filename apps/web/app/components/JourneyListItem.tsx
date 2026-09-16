import Link from "next/link";
import type { ReactElement } from "react";
import type { SearchItem } from "../../src/lib/api";

/**
 * One search result.
 *
 * Search keeps this list item; the Journeys page shows its rows as a table
 * (`JourneyRow`), where the columns carry what a browsing reader scans by.
 * `environment` is optional because search never spans environments in a way
 * a reader needs named.
 */
export function JourneyListItem({
  item,
  environment
}: {
  item: SearchItem;
  environment?: string;
}): ReactElement {
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
