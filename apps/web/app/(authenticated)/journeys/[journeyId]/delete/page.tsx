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
/** What the route handler's `error` values mean to the operator. Anything else reads as the last. */
const FAILURES: Record<string, string> = {
  api_unavailable:
    "The Flight Recorder API could not be reached, so nothing was deleted. Try again.",
  project_not_selected:
    "No project is selected, so nothing was deleted. Choose a project and try again.",
  unexpected: "Something went wrong and the journey was not deleted. Try again."
};

export default async function DeleteJourneyPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { journeyId } = await params;
  const { error: failure } = await searchParams;

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
        {failure === undefined ? null : (
          <p className="error" role="alert">
            {FAILURES[failure] ?? FAILURES["unexpected"]}
          </p>
        )}

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
