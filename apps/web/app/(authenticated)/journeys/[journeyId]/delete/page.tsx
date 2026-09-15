import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiUnavailableError, getJourney } from "../../../../../src/lib/api";
import { requireProjectId } from "../../../../../src/lib/current-project";

/**
 * Confirm deleting one journey.
 *
 * A page of its own rather than a button on the journey, for the reason replay
 * is not one click (REPLAY_SPEC section 13): the operator sees exactly what
 * goes before anything goes, and it cannot be undone.
 */
export default async function DeleteJourneyPage({
  params
}: {
  params: Promise<{ journeyId: string }>;
}) {
  const { journeyId } = await params;

  try {
    const projectId = await requireProjectId(`/journeys/${journeyId}/delete`);
    const journey = await getJourney(journeyId, projectId);
    if (journey === null) notFound();

    return (
      <main>
        <p className="muted">
          <Link href={`/journeys/${encodeURIComponent(journeyId)}`}>← Back to the journey</Link>
        </p>
        <h1>Delete this journey?</h1>

        <dl className="facts">
          <dt>Entity</dt>
          <dd className="mono">
            {journey.entity.type}: {journey.entity.id ?? "—"}
          </dd>
          <dt>Environment</dt>
          <dd>{journey.environment}</dd>
          <dt>Events</dt>
          <dd>{journey.eventCount}</dd>
        </dl>

        <p>
          Its events, aliases, and any replays of those events are deleted with it.{" "}
          <strong>This cannot be undone.</strong>
        </p>
        <p className="muted">
          The deletion is recorded in the audit log. Rows stay in the database files until vacuum
          reclaims them, and in any backup taken before now.
        </p>

        <form
          method="post"
          action={`/api/journeys/${encodeURIComponent(journeyId)}/delete`}
          className="stack confirm"
        >
          <input type="hidden" name="entityType" value={journey.entity.type} />
          <button type="submit" className="danger">
            Delete journey
          </button>
        </form>
      </main>
    );
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    throw error;
  }
}
