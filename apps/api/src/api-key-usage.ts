import { touchApiKey } from "@wayscribe/database";
import type { FastifyInstance } from "fastify";

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
export function touchApiKeyUsage(app: FastifyInstance, id: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);

  void touchApiKey(app.db, id).catch(() => {
    app.log.debug("failed to record API key usage");
  });
}
