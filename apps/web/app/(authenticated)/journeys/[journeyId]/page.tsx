import Link from "next/link";
import { notFound } from "next/navigation";
import { AliasList } from "../../../components/AliasList";
import { JourneyHeading } from "../../../components/JourneyHeading";
import { JourneyTimeline } from "../../../components/JourneyTimeline";
import { ApiUnavailableError, getEvent, getJourney, listEvents } from "../../../../src/lib/api";
import { requireProjectId } from "../../../../src/lib/current-project";
import { backFromJourney, toQueryString } from "../../../../src/lib/journey-filters";
import { isRecent } from "../../../../src/lib/timeline";

export default async function JourneyPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { journeyId } = await params;
  const query = await searchParams;
  const selectedId = typeof query["event"] === "string" ? query["event"] : undefined;
  // Back to the Journeys list a row link came from, else to Search.
  const back = backFromJourney(query);

  try {
    // Inside the try: this call reaches the API, and when it threw from
    // outside there was nothing to catch it and no error boundary anywhere in
    // the app, so a booting API rendered a blank HTTP 500.
    const search = toQueryString(query);
    const projectId = await requireProjectId(
      `/journeys/${journeyId}${search === "" ? "" : `?${search}`}`
    );
    const journey = await getJourney(journeyId, projectId);
    if (journey === null) notFound();

    const page = await listEvents(journeyId, projectId);
    if (page === null) notFound();

    // Default to the first event so the detail panel is never empty on arrival.
    const activeId = selectedId ?? page.items[0]?.id ?? null;
    const active = activeId === null ? null : await getEvent(activeId, projectId);

    return (
      <main id="main">
        <p className="muted">
          <Link href={back.href}>← {back.label}</Link>
        </p>
        <JourneyHeading journey={journey} />
        <p className="muted">All times UTC.</p>

        <AliasList aliases={journey.aliases} />

        <p className="muted">
          <Link href={`/journeys/${encodeURIComponent(journeyId)}/delete`}>
            Delete this journey
          </Link>
        </p>

        <JourneyTimeline
          journeyId={journeyId}
          initialStatus={journey.status}
          initialEvents={page.items}
          initialCursor={page.nextCursor}
          initialSelectedId={activeId}
          initialDetail={active}
          totalEvents={journey.eventCount}
          knownServices={journey.services}
          // Decided here, on one clock: a journey marked failed can still be
          // recording retries, and re-deciding it in the browser against a
          // different clock would be a hydration mismatch.
          initialLive={journey.status === "active" || isRecent(journey.lastEventAt, Date.now())}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return (
        <main id="main">
          <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>
        </main>
      );
    }
    throw error;
  }
}
