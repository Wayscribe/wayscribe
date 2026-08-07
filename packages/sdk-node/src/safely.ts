import type { DiagnosticKind, Diagnostics } from "./diagnostics.js";

/**
 * The single failure boundary. Every public entry point goes through it.
 *
 * ADR-007 requires that recorder failure never break the host application. A
 * try/catch per method would work until someone adds a method and forgets one;
 * one boundary cannot be forgotten.
 *
 * Returns undefined on failure. Callers treat that as "the recorder did not
 * manage it", which is always an acceptable outcome for telemetry.
 */
export function safely<T>(
  diagnostics: Diagnostics,
  kind: DiagnosticKind,
  operation: () => T
): T | undefined {
  try {
    return operation();
  } catch (error) {
    report(diagnostics, kind, error);
    return undefined;
  }
}

/**
 * The async half of the boundary.
 *
 * `safely` cannot guard an async callback: it returns the promise before the
 * rejection happens, so the try/catch never sees it. Any awaiting entry point
 * must use this instead.
 */
export async function safelyAsync<T>(
  diagnostics: Diagnostics,
  kind: DiagnosticKind,
  operation: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    report(diagnostics, kind, error);
    return undefined;
  }
}

function report(diagnostics: Diagnostics, kind: DiagnosticKind, error: unknown): void {
  diagnostics.report({
    kind,
    reason: error instanceof Error ? error.message : String(error),
    detail: error
  });
}
