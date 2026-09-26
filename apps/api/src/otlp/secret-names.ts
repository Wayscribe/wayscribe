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

/** An ingestion path, `input.gatewayApiToken`, as the OTLP attribute path. */
export function otlpPath(path: string): string {
  const end = path.search(/[.[]/);
  const field = end === -1 ? path : path.slice(0, end);
  const attribute = ATTRIBUTE_OF_FIELD[field];
  return attribute === undefined ? path : `${attribute}${path.slice(field.length)}`;
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
