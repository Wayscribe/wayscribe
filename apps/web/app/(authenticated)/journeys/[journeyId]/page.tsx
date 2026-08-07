import Link from "next/link";
import { notFound } from "next/navigation";
import { EventDetail } from "../../../components/EventDetail";
import { ApiUnavailableError, getEvent, getJourney, listEvents } from "../../../../src/lib/api";
import { requireProjectId } from "../../../../src/lib/current-project";

export default async function JourneyPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { journeyId } = await params;
  const { event: selectedId } = await searchParams;

  const projectId = await requireProjectId();

  try {
    const journey = await getJourney(journeyId, projectId);
    if (journey === null) notFound();

    const events = await listEvents(journeyId, projectId);
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
          {journey.status} · {journey.eventCount} events · {journey.services.join(", ")}
        </p>

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
                  <span className="mono time">{event.eventTimestamp.slice(11, 19)}</span>
                  <span className={event.hasError ? "op failed" : "op"}>{event.operation}</span>
                  <span className="muted">{event.service}</span>
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
