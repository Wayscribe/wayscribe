import { useId, type ReactElement } from "react";
import type { EventDetailData } from "../../src/lib/api";
import type { MetadataList } from "../../src/lib/metadata";

/**
 * An event's metadata as plain keys and values, one group per kind.
 *
 * The lists come from `getEvent`, which builds them on the server so both ways
 * the event reaches the browser carry the same keys. Every key and value is a
 * text child, which React escapes, so metadata is
 * never read as markup and needs nothing from the Content-Security-Policy.
 * A labelled vocabulary for common fields is on the roadmap; until then the
 * keys are the ones the instrumented code chose (F-044).
 */
export function EventMetadata({ event }: { event: EventDetailData }): ReactElement {
  const lists = event.metadata;
  const kinds: [string, MetadataList][] =
    lists === undefined
      ? []
      : [
          ["Custom", lists.custom],
          ["Deployment", lists.deployment],
          ["Runtime", lists.runtime]
        ];
  const shown = kinds.filter(([, list]) => list.entries.length > 0);

  return (
    <>
      <h3>Metadata</h3>
      {shown.length === 0 ? (
        <p className="muted">No metadata was recorded for this step.</p>
      ) : (
        <div className="metadata">
          {shown.map(([name, list]) => (
            <MetadataGroup key={name} name={name} list={list} />
          ))}
        </div>
      )}
    </>
  );
}

function MetadataGroup({ name, list }: { name: string; list: MetadataList }): ReactElement {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId}>
      <div id={labelId} className="label">
        {name}
      </div>
      <dl className="metadata-list">
        {list.entries.map((entry, index) => (
          // Keys can repeat once cut to length, so the position is part of it.
          <div key={`${String(index)}-${entry.key}`}>
            <dt className="mono">{entry.key}</dt>
            <dd className="mono">{entry.value}</dd>
          </div>
        ))}
      </dl>
      {list.omitted === 0 ? null : (
        <p className="muted">{`${String(list.omitted)} more not shown.`}</p>
      )}
    </div>
  );
}
