import { findApiKeyByPrefix, touchApiKey } from "@flight-recorder/database";
import type { Subkeys } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import { resolveApiKey } from "../auth.js";
import { ingestEvent } from "../ingestion/ingest-event.js";

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
  error?: { code: string | undefined; message: string | undefined };
}

export function registerEventRoutes(app: FastifyInstance, subkeys: Subkeys): void {
  app.post("/v1/events", async (request, reply) => {
    const auth = await resolveApiKey(request.headers.authorization, subkeys.apiKey, (prefix) =>
      findApiKeyByPrefix(app.db, prefix)
    );
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    touch(app, auth.context.id);

    const result = await ingestEvent(app.db, subkeys, auth.context, request.body);
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
    const auth = await resolveApiKey(request.headers.authorization, subkeys.apiKey, (prefix) =>
      findApiKeyByPrefix(app.db, prefix)
    );
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
      const result = await ingestEvent(app.db, subkeys, auth.context, event);
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
              error: { code: result.code, message: result.message }
            }
      );
    }

    return reply.code(202).send({ data: { results } });
  });
}

function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}
