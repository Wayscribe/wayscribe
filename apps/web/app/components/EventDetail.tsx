import Link from "next/link";
import type { EventDetailData } from "../../src/lib/api";
import { DiffTable } from "./DiffTable";
import { EXPLANATIONS } from "./explanations";

/** A line about the event being shown: that its replacement is loading, or failed to. */
export interface DetailNotice {
  text: string;
  /** The class it renders with: `error` keeps a failure red rather than grey. */
  tone: "muted" | "error";
}

export function EventDetail({
  event,
  notice = null
}: {
  event: EventDetailData;
  /** Rendered under the heading and its meta line, where the eye already is. */
  notice?: DetailNotice | null;
}) {
  return (
    <section>
      <h2>{event.name}</h2>
      <p className="muted wrap">
        {event.operation} · {event.service}
        {event.durationMs === null ? "" : ` · ${String(event.durationMs)} ms`}
      </p>
      {notice === null ? null : <p className={notice.tone}>{notice.text}</p>}

      {event.payloadDiff === null ? null : (
        <>
          <h3>What changed</h3>
          <p className="muted">
            The difference between what this step received and what it produced.{" "}
            {EXPLANATIONS.transformation}
          </p>
          <DiffTable
            key={event.id}
            changes={event.payloadDiff.changes}
            compared={wasCaptured(event)}
            collapsible
          />
          {event.payloadDiff.truncated ? (
            <p className="muted">Comparison truncated: too many changes to show.</p>
          ) : null}
        </>
      )}

      {!event.hasInput ? null : (
        <>
          <p>
            {/* A link, not a button. REPLAY_SPEC section 13 prohibits one-click
                replay from the timeline: sending a recorded request is a
                deliberate act and gets its own screen. */}
            <Link href={`/journeys/${event.journeyId}/replay?event=${event.id}`}>
              Replay this input →
            </Link>
          </p>
          <p className="muted">{EXPLANATIONS.replay}</p>
        </>
      )}

      {event.error === null ? null : (
        <>
          <h3>Error</h3>
          <pre className="mono block">{JSON.stringify(event.error, null, 2)}</pre>
        </>
      )}

      <h3>Payloads</h3>
      {!event.hasInput && !event.hasOutput ? (
        // Not "the capture policy stripped it": identify, finish and fail events
        // carry no payload by nature, a caller may record a step without one,
        // and the API does not say which of those happened.
        <p className="muted">
          No payload was recorded for this step. Some steps carry none, and an environment set to
          capture metadata only stores none for any step.
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
