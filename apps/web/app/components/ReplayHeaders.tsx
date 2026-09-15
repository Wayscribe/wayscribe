/** The marker the API stores in place of a header value it must not keep. */
const REDACTED = "[REDACTED]";

/**
 * The headers a replay sent, as the run recorded them.
 *
 * The API stores a destination's configured header values as `[REDACTED]`
 * because they are credentials, encrypted at rest on the destination and not
 * on the run. A bare `[REDACTED]` in a list of sent headers reads as though
 * that is what went out, which would send someone debugging an authentication
 * failure after the wrong cause, so the redacted rows say the real value was
 * sent.
 */
export function ReplayHeaders({
  headers,
  attempted = false
}: {
  headers: Record<string, string> | null;
  /** The request did not complete, so the headers were attempted rather than delivered. */
  attempted?: boolean;
}) {
  const entries = Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;

  const anyRedacted = entries.some(([, value]) => value === REDACTED);

  return (
    <>
      <h2>{attempted ? "Headers in the attempted request" : "Headers sent"}</h2>
      <table className="diff">
        <thead>
          <tr>
            <th>Header</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, value]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td className="mono">
                {value === REDACTED ? (
                  <>
                    {REDACTED} <span className="muted">(real value used, not stored)</span>
                  </>
                ) : (
                  value
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyRedacted ? (
        <p className="muted">
          Values shown as {REDACTED} {attempted ? "were in the attempt" : "were sent"} with their
          real values. Flight Recorder does not keep them with the replay record, because a
          destination&rsquo;s configured headers are credentials.
        </p>
      ) : null}
    </>
  );
}
