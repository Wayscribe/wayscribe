import Link from "next/link";
import type { ReactElement } from "react";
import type { SearchItem } from "../../src/lib/api";
import { LinkPending } from "./LinkPending";

/**
 * One search result.
 *
 * Search keeps this list item; the Journeys page shows its rows as a table
 * (`JourneyRow`), where the columns carry what a browsing reader scans by.
 */
export function JourneyListItem({ item }: { item: SearchItem }): ReactElement {
  return (
    <li>
      <Link href={`/journeys/${encodeURIComponent(item.journeyId)}`} className="mono">
        <LinkPending />
        {item.entity.type}: {item.entity.id ?? "—"}
      </Link>
      <span className={item.status === "failed" ? "status failed" : "status"}>{item.status}</span>
      {/* The admin token searches every environment of the project, so a row
          says which one it came from (F-036). Absent from an API older than
          the field, which then shows nothing rather than a guess. */}
      {item.environment === undefined ? null : (
        <span className="environment" title="Environment">
          {item.environment}
        </span>
      )}
      <span className="muted">
        {item.eventCount} {item.eventCount === 1 ? "event" : "events"} · last activity{" "}
        {item.lastEventAt.slice(0, 19).replace("T", " ")}
      </span>
    </li>
  );
}
