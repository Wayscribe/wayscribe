import { useId, type ReactElement } from "react";
import type { EventDetailData } from "../../src/lib/api";

const NOT_RECORDED =
  "Which aliases this event stated was not recorded: it was stored before the server kept them, or the API is older than this web app. Any aliases the journey has are listed at the top of the page.";

/**
 * The aliases an event stated (F-042), which is what an `identified` event
 * exists to record: read on its own, its detail used to say nothing about
 * what it identified.
 *
 * Shown for any event that stated some. For an `identified` event that stated
 * none, or whose aliases the API did not record, it says so; for any other
 * operation that is the ordinary case and it says nothing. The API masks a
 * value the way the journey read does, and a masked one is marked as masked,
 * as `AliasList` marks the journey's. Every type and value is a text child,
 * which React escapes.
 */
export function EventAliases({ event }: { event: EventDetailData }): ReactElement | null {
  const headingId = useId();
  const aliases = event.statedAliases;
  if ((aliases === null || aliases.length === 0) && event.operation !== "identified") return null;

  return (
    <>
      <h3 id={headingId}>Aliases stated</h3>
      {aliases === null ? (
        <p className="muted">{NOT_RECORDED}</p>
      ) : aliases.length === 0 ? (
        <p className="muted">This event stated no aliases.</p>
      ) : (
        <div role="group" aria-labelledby={headingId}>
          <dl className="metadata-list">
            {aliases.map((alias, index) => (
              <div key={`${String(index)}-${alias.type}`}>
                <dt className="mono">{alias.type}</dt>
                <dd className="mono">
                  {alias.value}
                  {alias.masked ? (
                    <span
                      className="masked"
                      title="Masked: this identifier was not marked displayable when it was recorded."
                    >
                      {" "}
                      (masked)
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}
