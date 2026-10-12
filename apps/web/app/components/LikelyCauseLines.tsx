import Link from "next/link";
import type { DisplayedLikelyCause } from "../../src/lib/likely-cause-display";

/**
 * "Likely cause: `phone` lost at **transform-salesforce-account** (was ...)",
 * one line per cause (ADR-072). The step links to its event in the timeline.
 * When the change lies below the reported field, the line names the changed
 * path, whose values it gives, and the field it sits in. The reporter is named
 * when it is not the failure being shown; the journey header passes
 * `failedEventId={null}`, so it always names it. "Likely", never "cause": the
 * link is the nearest change, not a proof.
 */
export function LikelyCauseLines({
  causes,
  journeyId,
  failedEventId,
  describeEvent
}: {
  causes: readonly DisplayedLikelyCause[];
  journeyId: string;
  /** The failed event the causes belong to, or null where it is not known. */
  failedEventId: string | null;
  /** A loaded step as the line names it, or null when the timeline has not loaded it. */
  describeEvent: (eventId: string) => string | null;
}) {
  if (causes.length === 0) return null;
  const href = (eventId: string): string =>
    `/journeys/${encodeURIComponent(journeyId)}?event=${encodeURIComponent(eventId)}`;
  return (
    <div className="likely-causes">
      {causes.map((cause) => (
        <div key={cause.field}>
          <p className="likely-cause wrap">
            Likely cause:{" "}
            {cause.changedPath === null ? (
              <code>{cause.field}</code>
            ) : (
              <>
                <code>{cause.changedPath}</code> (in <code>{cause.field}</code>)
              </>
            )}{" "}
            {cause.verb} at{" "}
            <strong>
              <Link href={href(cause.eventId)}>{cause.step}</Link>
            </strong>
            {cause.verb === "changed"
              ? ` (was ${cause.before}, now ${cause.after})`
              : ` (was ${cause.before})`}
            {cause.reportedBy === failedEventId ? null : (
              <>
                , reported by{" "}
                <Link href={href(cause.reportedBy)}>
                  {describeEvent(cause.reportedBy) ?? "an earlier failed step"}
                </Link>
              </>
            )}
          </p>
          {cause.alsoChangedAt.length === 0 ? null : (
            <p className="muted wrap">
              Also changed earlier at:{" "}
              {cause.alsoChangedAt.map((earlier, index) => (
                <span key={earlier.eventId}>
                  {index === 0 ? "" : ", "}
                  <Link href={href(earlier.eventId)}>{earlier.step}</Link>
                </span>
              ))}
            </p>
          )}
          {cause.incomplete ? (
            <p className="muted">Some earlier steps&apos; changes were too large to check.</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
