import Link from "next/link";
import { notFound } from "next/navigation";
import { DiffTable } from "../../../../components/DiffTable";
import { ReplayHeaders } from "../../../../components/ReplayHeaders";
import {
  ApiUnavailableError,
  getEvent,
  getReplay,
  listReplayDestinations
} from "../../../../../src/lib/api";
import { requireProjectId } from "../../../../../src/lib/current-project";

/**
 * Prepare and send a replay.
 *
 * `REPLAY_SPEC.md` section 13 prohibits one-click replay from the timeline, so
 * this is a separate screen that shows exactly what will be sent before
 * anything is sent. V0 shows the payload rather than letting it be edited
 * (ADR-032): review is what makes the confirmation meaningful, and editing the
 * input would test something other than the recorded failure.
 */
export default async function ReplayPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<{ event?: string; replay?: string }>;
}) {
  const { journeyId } = await params;
  const { event: eventId, replay: replayId } = await searchParams;
  const projectId = await requireProjectId();

  if (eventId === undefined) notFound();

  try {
    const event = await getEvent(eventId, projectId);
    if (event === null) notFound();

    const [destinations, run] = await Promise.all([
      listReplayDestinations(projectId),
      replayId === undefined ? Promise.resolve(null) : getReplay(replayId, projectId)
    ]);

    return (
      <main>
        <p className="muted">
          <Link href={`/journeys/${journeyId}?event=${eventId}`}>← Back to the journey</Link>
        </p>
        <h1>Replay this input</h1>
        <p className="muted">
          Sends what <span className="mono">{event.name}</span> received to a development
          destination, so you can check a fix against the input that actually failed. Nothing is
          sent to the system that originally received it.
        </p>

        {!event.hasInput ? (
          <p className="error">
            This step has no captured input, so there is nothing to replay. Its environment may be
            set to metadata-only capture.
          </p>
        ) : destinations.length === 0 ? (
          <>
            <h2>No destinations yet</h2>
            <p className="muted">
              A destination is a development, test, or local base URL that Flight Recorder is
              allowed to send to. Add one with:
            </p>
            <pre className="mono block">
              {`curl -X POST http://localhost:8080/v1/replay-destinations \\
  -H "authorization: Bearer $ADMIN_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"name":"local","baseUrl":"http://localhost:3200","environmentType":"development"}'`}
            </pre>
            <p className="muted">
              The host must also appear in <span className="mono">REPLAY_ALLOWED_HOSTS</span>.
            </p>
          </>
        ) : (
          <form method="post" action="/api/replay" className="replay-form">
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="journeyId" value={journeyId} />

            <label htmlFor="destinationId">Destination</label>
            <select id="destinationId" name="destinationId" required>
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name} — {destination.baseUrl} ({destination.environmentType})
                </option>
              ))}
            </select>

            <label htmlFor="method">Method</label>
            <select id="method" name="method" defaultValue="POST">
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
            </select>

            <label htmlFor="path">Path</label>
            <input id="path" name="path" defaultValue="/replay/customer" required />

            {/* debtwatch:start
                id: DEBT-GW41YJ
                owner: flight-recorder
                expires: 2027-02-01
                reason: ADR-032 defers payload editing to V1; this screen reviews but cannot change it
                tags: web, replay
                debtwatch:end */}
            <h2>What will be sent</h2>
            <pre className="mono block">{JSON.stringify(event.inputPayload, null, 2)}</pre>
            <p className="muted">
              Credentials recorded with the original request are never replayed. Flight Recorder
              sends its own user agent and any header the destination has configured.
            </p>

            <button type="submit">Send replay</button>
          </form>
        )}

        {run === null ? null : <Result run={run} />}
      </main>
    );
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    throw error;
  }
}

function Result({ run }: { run: NonNullable<Awaited<ReturnType<typeof getReplay>>> }) {
  if (run.status === "blocked") {
    return (
      <section>
        <h2>Refused</h2>
        <p className="error">{run.error?.message ?? "The replay was refused."}</p>
        <p className="muted">
          Nothing was sent. The attempt is recorded, including the reason
          {run.error?.reason === undefined ? "" : ` (${run.error.reason})`}.
        </p>
      </section>
    );
  }

  if (run.status === "failed") {
    return (
      <section>
        <h2>Could not reach the destination</h2>
        <p className="error">{run.error?.message ?? "The request failed."}</p>
        <ReplayHeaders headers={run.requestHeaders} attempted />
      </section>
    );
  }

  return (
    <section>
      <h2>Response</h2>
      <p className="muted">
        {run.responseStatus} · {run.durationMs} ms
      </p>
      <pre className="mono block">{JSON.stringify(run.responsePayload, null, 2)}</pre>

      <ReplayHeaders headers={run.requestHeaders} />

      <h2>Original versus replay</h2>
      {run.comparison === null ? (
        <p className="muted">
          There is no recorded output for this step, so there is nothing to compare against.
        </p>
      ) : (
        <>
          <DiffTable changes={run.comparison.changes} />
          <p className="muted">
            This compares what the step originally produced against what the destination returned
            now. Redacted fields compare as unchanged, so this cannot show that a redacted value was
            fixed.
          </p>
        </>
      )}
    </section>
  );
}
