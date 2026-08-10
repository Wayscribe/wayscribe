import Link from "next/link";
import { notFound } from "next/navigation";
import { EventDetail } from "../../../components/EventDetail";
import { ApiUnavailableError, getEvent, getJourney, listEvents } from "../../../../src/lib/api";
import { requireProjectId } from "../../../../src/lib/current-project";
import {
  SKEW_THRESHOLD_SECONDS,
  dayLabel,
  fullTimestamp,
  skewSeconds,
  spansDays,
  timeOfDay
} from "../../../../src/lib/time";

export default async function JourneyPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { journeyId } = await params;
  const { event: selectedId } = await searchParams;

  try {
    // Inside the try: this call reaches the API, and when it threw from
    // outside there was nothing to catch it and no error boundary anywhere in
    // the app, so a booting API rendered a blank HTTP 500.
    const projectId = await requireProjectId(`/journeys/${journeyId}`);
    const journey = await getJourney(journeyId, projectId);
    if (journey === null) notFound();

    const { items: events, complete } = await listEvents(journeyId, projectId);
    // Only shown when it changes something: a single-day journey does not need
    // a date on every row, and a multi-day one is unreadable without it.
    const multiDay = spansDays(events.map((event) => event.eventTimestamp));
    // Default to the first event so the detail panel is never empty on arrival.
    const activeId = selectedId ?? events[0]?.id;
    const active = activeId === undefined ? null : await getEvent(activeId, projectId);

    return (
      <main>
        <p className="muted">
          <Link href="/">← Search</Link>
        </p>
        <h1 className="mono">
          {journey.entity.type}: {journey.entity.id ?? "—"}
        </h1>
        <p className="muted">
          {journey.status} · {shown(events.length, journey.eventCount, complete)} ·{" "}
          {journey.services.join(", ")}
        </p>
        <p className="muted">All times UTC.</p>

        {journey.aliases.length === 0 ? null : (
          <p className="muted">
            Also known as{" "}
            {journey.aliases.map((a) => `${a.type} ${a.displayValue ?? "—"}`).join(", ")}. These
            identifiers all refer to the same record.
          </p>
        )}

        <div className="journey">
          <ol className="timeline">
            {events.map((event) => (
              <li key={event.id} className={event.id === activeId ? "active" : undefined}>
                <Link href={`/journeys/${journeyId}?event=${event.id}`}>
                  <span className="mono time" title={fullTimestamp(event.eventTimestamp)}>
                    {multiDay ? `${dayLabel(event.eventTimestamp)} ` : ""}
                    {timeOfDay(event.eventTimestamp)}
                  </span>
                  <span className={event.hasError ? "op failed" : "op"}>{event.operation}</span>
                  <span className="muted">{event.service}</span>
                  {skewSeconds(event.eventTimestamp, event.receivedAt) > SKEW_THRESHOLD_SECONDS ? (
                    <span
                      className="muted"
                      title={`Recorded at ${fullTimestamp(event.eventTimestamp)}, received at ${fullTimestamp(event.receivedAt)}. This service's clock may be wrong, which would put the timeline out of order.`}
                    >
                      ⚠ clock
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ol>
          <div className="detail">
            {active === null ? (
              <p className="muted">This journey has no events yet.</p>
            ) : (
              <EventDetail event={active} />
            )}
          </div>
        </div>
      </main>
    );
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    throw error;
  }
}

/**
 * How many events are on screen, and whether that is all of them.
 *
 * The header used to print the journey's true count above a list capped at a
 * hundred, with nothing saying so — the one number a reader would trust to know
 * whether they were seeing everything.
 */
function shown(rendered: number, total: number, complete: boolean): string {
  if (complete && rendered >= total) return `${String(total)} events`;
  return `showing ${String(rendered)} of ${String(total)} events`;
}
