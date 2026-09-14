import Link from "next/link";
import type { EventDetailData } from "../../src/lib/api";
import { DiffTable } from "./DiffTable";

export function EventDetail({
  event,
  collapsibleDiff = false
}: {
  event: EventDetailData;
  /** The timeline collapses long diffs; the replay view shows everything. */
  collapsibleDiff?: boolean;
}) {
  return (
    <section>
      <h2>{event.name}</h2>
      <p className="muted">
        {event.operation} · {event.service}
        {event.durationMs === null ? "" : ` · ${String(event.durationMs)} ms`}
      </p>

      {event.payloadDiff === null ? null : (
        <>
          <h3>What changed</h3>
          <p className="muted">
            The difference between what this step received and what it produced.
          </p>
          <DiffTable
            changes={event.payloadDiff.changes}
            compared={wasCaptured(event)}
            collapsible={collapsibleDiff}
          />
          {event.payloadDiff.truncated ? (
            <p className="muted">Comparison truncated: too many changes to show.</p>
          ) : null}
        </>
      )}

      {!event.hasInput ? null : (
        <p>
          {/* A link, not a button. REPLAY_SPEC section 13 prohibits one-click
              replay from the timeline: sending a recorded request is a
              deliberate act and gets its own screen. */}
          <Link href={`/journeys/${event.journeyId}/replay?event=${event.id}`}>
            Replay this input →
          </Link>
        </p>
      )}

      {event.error === null ? null : (
        <>
          <h3>Error</h3>
          <pre className="mono block">{JSON.stringify(event.error, null, 2)}</pre>
        </>
      )}

      <h3>Payloads</h3>
      {!event.hasInput && !event.hasOutput ? (
        <p className="muted">
          No payload captured. This environment&rsquo;s capture policy stores metadata only.
        </p>
      ) : (
        <div className="split">
          <div>
            <div className="label">Input</div>
            <pre className="mono block">{JSON.stringify(event.inputPayload, null, 2)}</pre>
          </div>
          <div>
            <div className="label">Output</div>
            <pre className="mono block">{JSON.stringify(event.outputPayload, null, 2)}</pre>
          </div>
        </div>
      )}
    </section>
  );
}

/** Markers the SDK stores in place of a payload it could not capture. */
const MARKERS = new Set(["[PAYLOAD_TOO_LARGE]", "[UNCAPTURABLE]"]);

/**
 * Whether both sides of this step hold real payloads.
 *
 * ADR-032 required this caveat and it was implemented — but only in the replay
 * view, not in the event detail view that shares the same component.
 */
function wasCaptured(event: EventDetailData): boolean {
  return !MARKERS.has(String(event.inputPayload)) && !MARKERS.has(String(event.outputPayload));
}
