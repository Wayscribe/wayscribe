import Link from "next/link";
import type { EventDetailData } from "../../src/lib/api";
import { DiffTable } from "./DiffTable";
import { EventMetadata } from "./EventMetadata";
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
            compared={event.payloadsCaptured}
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

      {event.errorText === null ? null : (
        <>
          <h3>Error</h3>
          <pre className="mono block">{event.errorText}</pre>
        </>
      )}

      <EventMetadata event={event} />

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
            <pre className="mono block">{event.inputText}</pre>
          </div>
          <div>
            <div className="label">Output</div>
            <pre className="mono block">{event.outputText}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
