"use client";

import { useState } from "react";
import type { DisplayedChange } from "../../src/lib/event-display";

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
 * The values arrive as text, written on the server (`displayChange`): a value
 * crossing to the browser as an object would lose a key named `__proto__`.
 *
 * Renames are paired and rows ordered on the server (`displayChanges`): a
 * value lost first, then altered values, then fields that only came or went,
 * then renames that kept their value, shown quietly. This component keeps that
 * order, and collapsing never hides a lost value: lost rows always render.
 *
 * Each row names its kind in words, so nothing is carried by colour alone.
 */
export function DiffTable({
  changes,
  compared = true,
  collapsible = false
}: {
  changes: DisplayedChange[];
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

  // A lost value is the row the reader came for: never behind the toggle.
  const collapsedRows = changes.filter((change, index) => index < COLLAPSED_ROWS || change.lost);
  const rows = collapsible && !expanded ? collapsedRows : changes;
  // Whether there is anything to disclose at all, independent of whether it's
  // currently shown — this decides whether the control renders.
  const collapsedCount = changes.length - collapsedRows.length;
  const showToggle = collapsible && collapsedCount > 0;
  const fieldNoun = collapsedCount === 1 ? "changed field" : "changed fields";

  return (
    <>
      <table className="diff">
        <thead>
          <tr>
            <th>Field</th>
            <th>Change</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((change) => (
            <tr
              key={`${change.from ?? ""}-${change.path}-${change.kind}`}
              className={change.lost ? "lost" : change.kind === "renamed" ? "renamed" : undefined}
            >
              <td className="mono">
                {change.from === null ? change.path : `${change.from} → ${change.path}`}
              </td>
              <td className="kind">{kindLabel(change)}</td>
              {change.kind === "renamed" ? (
                // The same value on both sides: shown once, across both columns.
                <td className="mono" colSpan={2}>
                  {change.before}
                </td>
              ) : (
                <>
                  <td className="mono removed">{change.before}</td>
                  <td className="mono added">{change.after}</td>
                </>
              )}
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
          {expanded
            ? "Show fewer changed fields"
            : `Show ${String(collapsedCount)} more ${fieldNoun}`}
        </button>
      ) : null}
    </>
  );
}

/** The row's kind in words: the table's colours only repeat it. */
function kindLabel(change: DisplayedChange): string {
  if (change.lost) return "value lost";
  switch (change.kind) {
    case "renamed":
      return "renamed";
    case "renamed-changed":
      return "renamed, value changed";
    default:
      return change.kind;
  }
}
