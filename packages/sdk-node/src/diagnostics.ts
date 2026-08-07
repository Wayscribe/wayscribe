export type DiagnosticKind = "dropped" | "transport_error" | "capture_error" | "breaker_open";

export interface Diagnostic {
  kind: DiagnosticKind;
  reason: string;
  detail?: unknown;
}

export interface Counters {
  dropped: number;
  transportErrors: number;
  captureErrors: number;
  breakerOpened: number;
  sent: number;
}

export interface Diagnostics {
  report(diagnostic: Diagnostic): void;
  recordSent(count: number): void;
  counters(): Counters;
}

/**
 * Failures go to counters and an optional callback, never to the console.
 *
 * SECURITY.md section 12 forbids recursive logging of recorder failures: a
 * recorder that writes to stderr on every failed flush becomes the incident
 * during an outage.
 */
export function createDiagnostics(onDiagnostic?: (diagnostic: Diagnostic) => void): Diagnostics {
  const counters: Counters = {
    dropped: 0,
    transportErrors: 0,
    captureErrors: 0,
    breakerOpened: 0,
    sent: 0
  };

  return {
    report(diagnostic) {
      if (diagnostic.kind === "dropped") counters.dropped += 1;
      if (diagnostic.kind === "transport_error") counters.transportErrors += 1;
      if (diagnostic.kind === "capture_error") counters.captureErrors += 1;
      if (diagnostic.kind === "breaker_open") counters.breakerOpened += 1;

      try {
        onDiagnostic?.(diagnostic);
      } catch {
        // A diagnostics callback that throws must not become the failure it was
        // reporting.
      }
    },
    recordSent(count) {
      counters.sent += count;
    },
    counters: () => ({ ...counters })
  };
}
