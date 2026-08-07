import { loadServerEnv } from "@flight-recorder/config";
import { createKnexConfig } from "@flight-recorder/database";
import knex from "knex";
import { buildApp } from "./app.js";

// Parsed before anything else, so a misconfigured process fails immediately with
// a message naming the offending variable rather than at first use.
const env = loadServerEnv(process.env);

const db = knex(createKnexConfig(env.DATABASE_URL));
const app = buildApp({ db, logLevel: env.LOG_LEVEL });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  // 0.0.0.0 is correct inside a container; Compose restricts exposure by binding
  // published ports to 127.0.0.1 on the host.
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}
