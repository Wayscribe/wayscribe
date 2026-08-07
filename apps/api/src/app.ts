import type { Subkeys } from "@flight-recorder/payload-security";
import Fastify, { type FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerQueryRoutes } from "./routes/queries.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
  }
}

export interface BuildAppOptions {
  db: Knex;
  subkeys: Subkeys;
  adminToken: string;
  logLevel?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" }
  });

  app.decorate("db", options.db);
  registerHealthRoutes(app);
  registerEventRoutes(app, options.subkeys);
  registerProjectRoutes(app, options.adminToken);
  registerQueryRoutes(app, options.subkeys, options.adminToken);

  return app;
}
