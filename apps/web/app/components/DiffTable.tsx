import type { DiffChange } from "../../src/lib/api";

function render(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/**
 * Renders the structural diff as-is: one row per changed path.
 *
 * Deliberately not a unified −/+ view. We compute {path, kind, before, after},
 * never a text diff, and input and output routinely use different field names —
 * `Phone` versus `phone` — so a single-column rendering would have to pick one
 * and mislead about the other.
 */
export function DiffTable({
  changes,
  compared = true
}: {
  changes: DiffChange[];
  /** False when one side was never captured, so there was nothing to compare. */
  compared?: boolean;
}) {
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

  return (
    <table className="diff">
      <thead>
        <tr>
          <th>Field</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={`${change.path}-${change.kind}`}>
            <td className="mono">{change.path}</td>
            <td className="mono removed">{render(change.before)}</td>
            <td className="mono added">{render(change.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
