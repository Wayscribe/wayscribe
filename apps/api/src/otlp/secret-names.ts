/**
 * The attribute each event field is read from (`mapping.ts`), so a warning
 * names what the sender wrote, `wayscribe.input.gatewayApiToken`, rather than
 * the stored field. A field no attribute fills keeps its own name.
 */
const ATTRIBUTE_OF_FIELD: Readonly<Record<string, string>> = Object.freeze({
  input: "wayscribe.input",
  output: "wayscribe.output",
  metadata: "wayscribe.metadata",
  error: "wayscribe.error"
});

/** The longest path kept, logged or remembered; the response shows fewer. */
export const MAX_PATH_KEPT = 256;

/**
 * An ingestion path, `input.gatewayApiToken`, as the OTLP attribute path, cut
 * to {@link MAX_PATH_KEPT} characters. Key names are the sender's to choose and
 * a payload may hold one of any length, so without the cut one request could
 * fill a log line, and the process's memory of what it warned about.
 */
export function otlpPath(path: string): string {
  const end = path.search(/[.[]/);
  const field = end === -1 ? path : path.slice(0, end);
  const attribute = ATTRIBUTE_OF_FIELD[field];
  const named = attribute === undefined ? path : `${attribute}${path.slice(field.length)}`;
  return named.length > MAX_PATH_KEPT ? `${named.slice(0, MAX_PATH_KEPT - 3)}...` : named;
}

/** The most paths one log line names; the rest are counted. */
export const LOGGED_PATHS = 20;

/**
 * Which (environment, path) pairs this process has already logged a warning
 * for, so a sender that repeats the same names every batch is told once, not
 * once per request (ADR-068). The response still warns every time: it is the
 * sender's copy, and the log is the operator's.
 *
 * Bounded: when full it forgets everything and starts again, so a sender
 * inventing names cannot grow it, and the cost is a repeated warning.
 */
export class WarnedSecretNames {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 10_000) {}

  /** The paths not yet logged for this environment, now marked logged. */
  fresh(environmentId: string, paths: Iterable<string>): string[] {
    const fresh: string[] = [];
    for (const path of paths) {
      const key = `${environmentId}\u0000${path}`;
      if (this.seen.has(key)) continue;
      if (this.seen.size >= this.capacity) this.seen.clear();
      this.seen.add(key);
      fresh.push(path);
    }
    return fresh;
  }
}
