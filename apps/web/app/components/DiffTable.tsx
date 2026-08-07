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
export function DiffTable({ changes }: { changes: DiffChange[] }) {
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
