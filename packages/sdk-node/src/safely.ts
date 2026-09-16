import type { BoundaryKind, Diagnostics } from "./diagnostics.js";

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
  kind: BoundaryKind,
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
  kind: BoundaryKind,
  operation: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    report(diagnostics, kind, error);
    return undefined;
  }
}

/** The reason for a thrown value that cannot be turned into text. */
export const UNDESCRIBABLE = "A value was thrown that cannot be described.";

/**
 * A thrown value as text, or `UNDESCRIBABLE`. Never throws: `String()` of a
 * null-prototype object throws, and so do `instanceof` and `String()` of a
 * revoked Proxy, and the boundary must not throw a second time into the host.
 */
export function describeThrown(error: unknown): string {
  try {
    const text: unknown = error instanceof Error ? error.message : String(error);
    return typeof text === "string" ? text : String(text);
  } catch {
    return UNDESCRIBABLE;
  }
}

function report(diagnostics: Diagnostics, kind: BoundaryKind, error: unknown): void {
  try {
    diagnostics.report({
      kind,
      code: "unexpected_error",
      reason: describeThrown(error),
      detail: { error }
    });
  } catch {
    // Reporting is itself guarded; this is the last line, and it stays silent
    // rather than become the failure it was reporting.
  }
}
