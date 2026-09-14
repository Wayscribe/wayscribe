"use client";

import { useState } from "react";
import type { DiffChange } from "../../src/lib/api";

function render(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/** Enough to show the shape of a change without scrolling past the replay link. */
const COLLAPSED_ROWS = 8;

/**
 * Renders the structural diff as-is: one row per changed path.
 *
 * Deliberately not a unified −/+ view. We compute {path, kind, before, after},
 * never a text diff, and input and output routinely use different field names —
 * `Phone` versus `phone` — so a single-column rendering would have to pick one
 * and mislead about the other.
 *
 * Rows are never reordered when collapsed: the API's order is the order a
 * reader can reason about, and "the interesting rows first" is a judgement the
 * tool has no basis to make.
 */
export function DiffTable({
  changes,
  compared = true,
  collapsible = false
}: {
  changes: DiffChange[];
  /** False when one side was never captured, so there was nothing to compare. */
  compared?: boolean;
  /** Show the first rows and a button for the rest. Off for the replay view. */
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!compared) {
    // "No fields changed" is a claim about the data. Making it when nothing was
    // compared is the worst thing a debugging tool can do: the reader concludes
    // the step is innocent and looks elsewhere.
    return (
      <p className="muted">
        This step&rsquo;s payloads were not captured, so there is nothing to compare. A payload
        larger than the configured limit is recorded as a marker rather than stored.
      </p>
    );
  }

  if (changes.length === 0) {
    return <p className="muted">No fields changed between input and output.</p>;
  }

  const rows = collapsible && !expanded ? changes.slice(0, COLLAPSED_ROWS) : changes;
  // Whether there is anything to disclose at all, independent of whether it's
  // currently shown — this decides whether the control renders, not `hiddenCount`.
  const collapsedCount = Math.max(changes.length - COLLAPSED_ROWS, 0);
  const showToggle = collapsible && collapsedCount > 0;

  return (
    <>
      <table className="diff">
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((change) => (
            <tr key={`${change.path}-${change.kind}`}>
              <td className="mono">{change.path}</td>
              <td className="mono removed">{render(change.before)}</td>
              <td className="mono added">{render(change.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {showToggle ? (
        <button
          type="button"
          className="plain"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? "Show fewer" : `Show ${String(collapsedCount)} more changed fields`}
        </button>
      ) : null}
    </>
  );
}
