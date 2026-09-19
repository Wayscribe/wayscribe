import type { ReactElement } from "react";
import { formatDuration, journeySpan } from "../../src/lib/timing-presentation";

export function JourneyTimingSummary(props: {
  startedAt: string;
  lastEventAt: string;
}): ReactElement | null {
  const span = journeySpan(props.startedAt, props.lastEventAt);
  return (
    <p className="muted timing-summary">
      Recorded span: {span === null ? "unknown" : formatDuration(span)} — from the first recorded
      event start to the last recorded event start. It is not a sum of step durations, and different
      service clocks can disagree.
    </p>
  );
}
