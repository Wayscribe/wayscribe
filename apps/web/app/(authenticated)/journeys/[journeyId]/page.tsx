import Link from "next/link";
import { notFound } from "next/navigation";
import { JourneyTimeline } from "../../../components/JourneyTimeline";
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

  try {
    // Inside the try: this call reaches the API, and when it threw from
    // outside there was nothing to catch it and no error boundary anywhere in
    // the app, so a booting API rendered a blank HTTP 500.
    const projectId = await requireProjectId(`/journeys/${journeyId}`);
    const journey = await getJourney(journeyId, projectId);
    if (journey === null) notFound();

    const page = await listEvents(journeyId, projectId);
    if (page === null) notFound();

    // Default to the first event so the detail panel is never empty on arrival.
    const activeId = selectedId ?? page.items[0]?.id ?? null;
    const active = activeId === null ? null : await getEvent(activeId, projectId);

    return (
      <main>
        <p className="muted">
          <Link href="/">← Search</Link>
        </p>
        <h1 className="mono">
          {journey.entity.type}: {journey.entity.id ?? "—"}
        </h1>
        <p className="muted">All times UTC.</p>

        {journey.aliases.length === 0 ? null : (
          <p className="muted">
            Also known as{" "}
            {journey.aliases.map((a) => `${a.type} ${a.displayValue ?? "—"}`).join(", ")}. These
            identifiers all refer to the same record.
          </p>
        )}

        <JourneyTimeline
          journeyId={journeyId}
          initialStatus={journey.status}
          initialEvents={page.items}
          initialCursor={page.nextCursor}
          initialSelectedId={activeId}
          initialDetail={active}
          totalEvents={journey.eventCount}
          knownServices={journey.services}
          initialLastEventAt={journey.lastEventAt}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    throw error;
  }
}
