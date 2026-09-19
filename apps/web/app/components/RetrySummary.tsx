import { useMemo, type MouseEvent, type ReactElement } from "react";
import type { EventListItem } from "../../src/lib/api";
import { formatDuration, retryGroups } from "../../src/lib/timing-presentation";

export function RetrySummary({
  journeyId,
  events,
  complete,
  selectionQuery,
  onSelect
}: {
  journeyId: string;
  events: readonly EventListItem[];
  complete: boolean;
  /** The server-rendered query, retained by real links for no-JS and modifier clicks. */
  selectionQuery: string;
  onSelect: (eventId: string) => void;
}): ReactElement | null {
  const groups = useMemo(() => retryGroups(events, complete), [events, complete]);
  const unlinked = useMemo(
    () =>
      events.filter(
        (event) =>
          event.timingContext?.attempt !== undefined && event.timingContext.retryGroup === undefined
      ),
    [events]
  );
  if (groups.length === 0 && unlinked.length === 0) return null;

  return (
    <section className="retry-summary" aria-labelledby="recorded-attempts-heading">
      <h2 id="recorded-attempts-heading">Recorded attempts</h2>
      <p className="muted">
        Attempts are linked only when the recorder supplied one explicit retry identity. Observed
        retry delay is elapsed evidence between attempts; Requested Retry-After is shown separately
        on the event that recorded it.
      </p>
      {groups.map((group) => (
        <div
          key={JSON.stringify([group.service, group.name, group.retryGroup])}
          role="group"
          aria-label={`Recorded attempts for ${group.name}, retry identity ${group.retryGroup}`}
          className="retry-group"
        >
          <p>
            <strong>{group.name}</strong> <span className="muted">in {group.service}</span>
          </p>
          <p className="muted">
            retry identity <span className="mono">{group.retryGroup}</span>
          </p>
          <ol>
            {group.attempts.map((attempt) => (
              <li key={attempt.eventId}>
                <a
                  href={eventHref(journeyId, attempt.eventId, selectionQuery)}
                  onClick={(click) => {
                    selectInPlace(click, attempt.eventId, onSelect);
                  }}
                >
                  {attempt.number === null
                    ? "Attempt number unknown"
                    : `Attempt ${String(attempt.number)}`}
                </a>
                <span className={attempt.outcome === "failed" ? "failed" : undefined}>
                  {attempt.outcome}
                </span>
                {attempt.delayMs === null ? null : (
                  <>
                    <span className="muted">
                      observed retry delay {formatDuration(attempt.delayMs)}
                    </span>
                    {attempt.delayClockCaveat === null ? null : (
                      <span className="muted">{attempt.delayClockCaveat}</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
          {group.issues.map((issue) => (
            <p className="muted" key={issue}>
              {issue}
            </p>
          ))}
        </div>
      ))}
      {unlinked.length === 0 ? null : (
        <div role="group" aria-label="Unlinked recorded attempts" className="retry-group">
          <p>No retry identity was recorded, so these attempts cannot be safely linked.</p>
          <ul>
            {unlinked.map((event) => (
              <li key={event.id}>
                <a
                  href={eventHref(journeyId, event.id, selectionQuery)}
                  onClick={(click) => {
                    selectInPlace(click, event.id, onSelect);
                  }}
                >
                  {event.service} · {event.name} · attempt {event.timingContext?.attempt}
                </a>
                <span
                  className={event.hasError || event.operation === "failed" ? "failed" : undefined}
                >
                  {event.hasError || event.operation === "failed" ? "failed" : "succeeded"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function eventHref(journeyId: string, eventId: string, selectionQuery: string): string {
  const query = new URLSearchParams(selectionQuery);
  query.set("event", eventId);
  return `/journeys/${encodeURIComponent(journeyId)}?${query.toString()}`;
}

function selectInPlace(
  click: MouseEvent<HTMLAnchorElement>,
  eventId: string,
  onSelect: (eventId: string) => void
): void {
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0) return;
  click.preventDefault();
  onSelect(eventId);
}
