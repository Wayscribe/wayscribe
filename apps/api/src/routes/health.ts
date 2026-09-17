import { pendingMigrationCount } from "@wayscribe/database";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
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
        reason: "database_unreachable"
      });
    }

    const pendingCount = await pendingMigrationCount(app.db);
    if (pendingCount > 0) {
      return reply.code(503).send({
        status: "not_ready",
        reason: "migrations_pending",
        pendingCount
      });
    }

    return { status: "ready" };
  });
}
