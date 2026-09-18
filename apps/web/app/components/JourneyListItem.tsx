import Link from "next/link";
import type { ReactElement } from "react";
import type { SearchItem } from "../../src/lib/api";
import { failedStepOf } from "../../src/lib/failed-step";
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
      <Status status={item.status} failedStep={failedStepOf(item)} />
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

/**
 * The status, as `failed at <step>` when the API names the step that failed
 * the journey (ADR-063). The status is set in capitals by the stylesheet; a
 * step name is an identifier, so it keeps its own case.
 */
function Status({
  status,
  failedStep
}: {
  status: string;
  failedStep: string | null;
}): ReactElement {
  return (
    <span className={status === "failed" ? "status failed" : "status"}>
      {failedStep === null ? (
        status
      ) : (
        <>
          {status} at <span className="status-step">{failedStep}</span>
        </>
      )}
    </span>
  );
}
