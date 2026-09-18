import { pendingMigrationCount } from "@wayscribe/database";
import type { FastifyInstance } from "fastify";
import { runningVersion, type RunningVersion } from "../version.js";

/**
 * `/health` and `/ready`, which answer different questions.
 *
 * `/ready` names the running version (F-007). Neither endpoint said what
 * Wayscribe was running, so a report recording what it ran against could not
 * confirm it from the API itself and had to take the operator's own pin on
 * trust. It is on `/ready` rather than `/health` because a load balancer hits
 * `/health` every few seconds and it must stay the cheapest possible answer,
 * and because the question "what is running" is asked at the same moment as
 * "is it serving", which is what `/ready` is for. It is on the 503 answers too:
 * when something is wrong the first question is what is running.
 *
 * Unauthenticated, as both endpoints already are. A version and a commit are
 * what the image tag already says in the registry, and the operator chose to
 * expose these ports; nothing here is derived from stored data.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  running: RunningVersion = runningVersion()
): void {
  // Liveness only. Deliberately does not touch the database: if it did, a
  // transient database blip would make an orchestrator restart a healthy process.
  app.get("/health", () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await app.db.raw("select 1");
    } catch (error) {
      // The driver error can carry the connection string. Log it, never return it.
      app.log.error({ err: error }, "readiness check: database unreachable");
      return reply.code(503).send({
        status: "not_ready",
        reason: "database_unreachable",
        ...running
      });
    }

    const pendingCount = await pendingMigrationCount(app.db);
    if (pendingCount > 0) {
      return reply.code(503).send({
        status: "not_ready",
        reason: "migrations_pending",
        pendingCount,
        ...running
      });
    }

    return { status: "ready", ...running };
  });
}
