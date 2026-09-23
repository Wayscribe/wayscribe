import { isStatementTimeout } from "@wayscribe/database";

/**
 * SQLSTATE classes and codes a retry of the same export can succeed after:
 * connection exceptions (08), insufficient resources (53), operator
 * intervention such as a restart (57P01..57P03), and concurrency failures
 * (40001 serialization, 40P01 deadlock).
 */
const TRANSIENT_SQLSTATE_CLASSES = new Set(["08", "53"]);
const TRANSIENT_SQLSTATES = new Set(["57P01", "57P02", "57P03", "40001", "40P01"]);
/** Socket and DNS failures between the API and PostgreSQL. */
const TRANSIENT_ERRNOS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN"
]);
/** node-postgres reports a dropped or never-made connection without a code. */
const CONNECTION_MESSAGES = [/Connection terminated/i, /timeout exceeded when trying to connect/i];

/**
 * Whether an OTLP failure is one a Collector should retry (503).
 *
 * Everything else is a 500: a Collector retries 503 with the identical export,
 * so a deterministic failure answered 503 would be retried forever.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (isStatementTimeout(error)) return true;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (name === "KnexTimeoutError") return true;
  if (typeof code === "string") {
    if (TRANSIENT_ERRNOS.has(code) || TRANSIENT_SQLSTATES.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code) && TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2))) return true;
  }
  return (
    typeof message === "string" && CONNECTION_MESSAGES.some((pattern) => pattern.test(message))
  );
}
