import type { IngestResult } from "./ingest-event.js";
import type { EventResult } from "../metrics/api-metrics.js";

export function eventResult(result: IngestResult): EventResult {
  if (result.status === "rejected") return "rejected";
  return result.duplicate === true ? "duplicate" : "accepted";
}

/**
 * A storage failure, described without leaking the database's own vocabulary.
 *
 * A pg error carries `.code` — a SQLSTATE like `22P05` — and no `.statusCode`,
 * so the shared error handler used to publish it verbatim as the API's error
 * code. `22P05` tells an SDK user nothing; naming the likely cause tells them
 * where to look.
 *
 * `22P05` is a NUL in jsonb, `22021` a NUL in text, and `22P02` a lone
 * surrogate in jsonb, which `JSON.stringify` writes as a `\ud800` escape that
 * PostgreSQL's JSON parser refuses. `22P02` is also a malformed uuid, but every
 * uuid ingestion writes comes from the authenticated key's own row, so here it
 * can only be the payload.
 */
export function storageRejection(error: unknown): IngestResult {
  const sqlState = (error as { code?: unknown } | null)?.code;
  const unsupportedText = sqlState === "22P05" || sqlState === "22021" || sqlState === "22P02";

  return {
    eventId: null,
    journeyId: null,
    status: "rejected",
    code: unsupportedText ? "unstorable_payload" : "storage_error",
    message: unsupportedText
      ? "The payload contains characters PostgreSQL cannot store, such as a NUL byte or an unpaired surrogate."
      : "The event could not be stored.",
    httpStatus: unsupportedText ? 400 : 500
  };
}
