import { touchApiKey } from "@flight-recorder/database";
import type { Keyring } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import { databaseApiKeys, logVerifierReplaceFailure, resolveApiKey } from "../auth.js";
import { ingestEvent, type IngestResult } from "../ingestion/ingest-event.js";

const MAX_BATCH_SIZE = 100;

/**
 * How stale `last_used_at` is allowed to get.
 *
 * Ingestion is the hot path and a key is presented on every event, so writing
 * this row per request would add a write to a request that already has one. An
 * operator deciding whether a key is still in use does not need the last minute;
 * they need to know it was not last year.
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/**
 * Record that a key was used, at most once a minute, without blocking the reply.
 *
 * Errors are swallowed deliberately: failing an accepted ingestion because a
 * bookkeeping write failed would trade real data for a timestamp.
 */
function touch(app: FastifyInstance, id: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);

  void touchApiKey(app.db, id).catch((error: unknown) => {
    app.log.debug({ err: error }, "failed to record API key usage");
  });
}

interface BatchResult {
  eventId: string | null;
  status: "accepted" | "rejected";
  duplicate?: boolean;
  /**
   * `httpStatus` is what the same rejection would have returned from the
   * single-event route. It rides along because the batch route always replies
   * 202 — the transport succeeded — and the client needs to tell a permanent
   * refusal (4xx, do not retry) from a transient one.
   */
  error?: {
    code: string | undefined;
    message: string | undefined;
    httpStatus: number;
    details?: { path: string; message: string }[];
  };
}

export function registerEventRoutes(
  app: FastifyInstance,
  keyring: Keyring,
  maxEventPayloadBytes: number,
  allowFullPayload: boolean
): void {
  const apiKeys = databaseApiKeys(app.db, keyring, logVerifierReplaceFailure(app.log));

  app.post("/v1/events", async (request, reply) => {
    const auth = await resolveApiKey(request.headers.authorization, apiKeys);
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    touch(app, auth.context.id);

    const result = await ingestEvent(
      app.db,
      keyring,
      auth.context,
      request.body,
      maxEventPayloadBytes,
      allowFullPayload
    );
    if (result.status === "rejected") {
      return reply
        .code(result.httpStatus)
        .send(errorBody(result.code ?? "invalid_event", result.message ?? "", request.id));
    }

    return reply.code(202).send({
      data: {
        eventId: result.eventId,
        journeyId: result.journeyId,
        status: "accepted",
        duplicate: result.duplicate ?? false
      }
    });
  });

  app.post("/v1/events/batch", async (request, reply) => {
    const auth = await resolveApiKey(request.headers.authorization, apiKeys);
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    touch(app, auth.context.id);

    const body = request.body as { events?: unknown } | undefined;
    const events = body?.events;
    if (!Array.isArray(events)) {
      return reply
        .code(400)
        .send(errorBody("invalid_event", "Body must contain an events array.", request.id));
    }

    if (events.length > MAX_BATCH_SIZE) {
      // Rejected before any event is processed, per SECURITY.md section 11.
      return reply
        .code(400)
        .send(
          errorBody(
            "payload_too_large",
            `A batch may contain at most ${String(MAX_BATCH_SIZE)} events.`,
            request.id
          )
        );
    }

    const results: BatchResult[] = [];
    for (const event of events) {
      // Sequential and independent: one event's failure never affects another's.
      //
      // That was a claim rather than a fact until this try/catch existed. An
      // unstorable value — a NUL byte from a fixed-width export, a lone
      // surrogate from a sliced emoji — threw out of ingestEvent, escaped the
      // loop, and returned a 500 that discarded every event in the batch,
      // including the ones already stored.
      let result;
      try {
        result = await ingestEvent(
          app.db,
          keyring,
          auth.context,
          event,
          maxEventPayloadBytes,
          allowFullPayload
        );
      } catch (error) {
        app.log.warn({ err: error }, "event rejected by storage");
        result = storageRejection(error);
      }
      results.push(
        result.status === "accepted"
          ? {
              eventId: result.eventId,
              status: "accepted",
              duplicate: result.duplicate ?? false
            }
          : {
              eventId: result.eventId,
              status: "rejected",
              error: {
                code: result.code,
                message: result.message,
                httpStatus: result.httpStatus,
                ...(result.details === undefined ? {} : { details: result.details })
              }
            }
      );
    }

    return reply.code(202).send({ data: { results } });
  });
}

function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}

/**
 * A storage failure, described without leaking the database's own vocabulary.
 *
 * A pg error carries `.code` — a SQLSTATE like `22P05` — and no `.statusCode`,
 * so the shared error handler used to publish it verbatim as the API's error
 * code. `22P05` tells an SDK user nothing; naming the likely cause tells them
 * where to look.
 */
function storageRejection(error: unknown): IngestResult {
  const sqlState = (error as { code?: unknown } | null)?.code;
  const unsupportedText = sqlState === "22P05" || sqlState === "22021";

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
