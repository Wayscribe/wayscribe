import Fastify, { type FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { registerHealthRoutes } from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
  }
}

export interface BuildAppOptions {
  db: Knex;
  logLevel?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" }
  });

  app.decorate("db", options.db);
  registerHealthRoutes(app);

  return app;
}
