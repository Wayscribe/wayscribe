import { useId, type ReactElement } from "react";
import type { EventDetailData } from "../../src/lib/api";
import { formatDuration } from "../../src/lib/timing-presentation";

export function OperationalContext({ event }: { event: EventDetailData }): ReactElement | null {
  const labelId = useId();
  const context = event.timingContext ?? {};
  const rows: [string, string][] = [];
  if (context.queue !== undefined) rows.push(["Queue", context.queue]);
  if (context.queueWaitMs !== undefined && context.queueWaitBasis !== undefined) {
    const basis =
      context.queueWaitBasis === "initial-enqueue"
        ? "initial enqueue to attempt start"
        : "retry readiness to attempt start";
    rows.push(["Measured queue wait", `${formatDuration(context.queueWaitMs)} (${basis})`]);
  }
  if (context.deliveryCount !== undefined) {
    rows.push(["Delivery count", String(context.deliveryCount)]);
  }
  if (context.attempt !== undefined) {
    const outcome = event.hasError || event.operation === "failed" ? "failed" : "succeeded";
    rows.push(["Attempt", `${String(context.attempt)} — ${outcome}`]);
  }
  if (context.retryGroup !== undefined) rows.push(["Retry identity", context.retryGroup]);
  if (context.targetHost !== undefined) rows.push(["Target host", context.targetHost]);
  if (context.httpStatusCode !== undefined) {
    rows.push(["HTTP status", String(context.httpStatusCode)]);
  }
  if (context.retryAfterMs !== undefined) {
    rows.push(["Requested Retry-After", formatDuration(context.retryAfterMs)]);
  }
  if (event.recordedHost != null) rows.push(["Recorded host", event.recordedHost]);
  if (rows.length === 0) return null;

  return (
    <>
      <h3 id={labelId}>Operational context</h3>
      <div role="group" aria-labelledby={labelId} className="operational-context">
        <dl className="metadata-list">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="mono">{value}</dd>
            </div>
          ))}
        </dl>
        {context.attempt !== undefined && context.retryGroup === undefined ? (
          <p className="muted">
            No retry identity was recorded, so attempts cannot be safely linked.
          </p>
        ) : null}
      </div>
    </>
  );
}
