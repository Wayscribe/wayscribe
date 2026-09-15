import type { Knex } from "knex";

/**
 * Lift the API's statement timeout for the rest of one transaction.
 *
 * For deletions only: a retention batch, and an admin's journey deletion,
 * erasure batch, or destination deletion. Each is bounded by its batch size
 * and started by the system or an operator, not by a request anyone can send
 * repeatedly, and a cascade over a large journey legitimately runs longer than
 * a search should. Cancelling one mid-way only repeats it, and a retention
 * batch cancelled every hour never lets the sweep reach the next environment.
 *
 * `LOCAL`, so the setting ends with the transaction and the pooled connection
 * goes back with the API's timeout in force. Harmless where no timeout was set,
 * as in the database CLI.
 */
export async function withoutStatementTimeout(trx: Knex.Transaction): Promise<void> {
  await trx.raw("set local statement_timeout = 0");
}

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
