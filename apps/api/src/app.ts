import type { Subkeys } from "@flight-recorder/payload-security";
import Fastify, { type FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerQueryRoutes } from "./routes/queries.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
  }
}

export interface BuildAppOptions {
  db: Knex;
  subkeys: Subkeys;
  logLevel?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" }
  });

  app.decorate("db", options.db);
  registerHealthRoutes(app);
  registerEventRoutes(app, options.subkeys);
  registerQueryRoutes(app, options.subkeys);

  return app;
}
