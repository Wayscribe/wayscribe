/** SQLSTATE `query_canceled`, which PostgreSQL raises when `statement_timeout` fires. */
const QUERY_CANCELED = "57014";

/**
 * Whether a query failed because the database cancelled it.
 *
 * Matched on the SQLSTATE rather than the message, which the server localises.
 * The same code covers `pg_cancel_backend`, an operator cancelling a query by
 * hand; both mean the statement ran too long for someone, and both are
 * answered the same way.
 */
export function isStatementTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === QUERY_CANCELED
  );
}
