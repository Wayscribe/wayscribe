import { findInsecureDefaults } from "@flight-recorder/config";
import { createKnexConfig } from "@flight-recorder/database";
import knex from "knex";
import { buildApp } from "./app.js";
import { checkKeysAtBoot } from "./key-warnings.js";
import { startRetentionJob } from "./retention-job.js";
import { prepareStartup } from "./startup.js";

// Parsed before anything else, so a misconfigured process fails immediately with
// a message naming the offending variable rather than at first use. The keyring
// is built here too, once, before anything listens.
const startup = prepareStartup(process.env);
if (!startup.ok) {
  // No logger exists yet: it is configured from the environment that failed.
  console.error(startup.message);
  process.exit(1);
}
const { env, keyring } = startup;

const db = knex(createKnexConfig(env.DATABASE_URL));
const app = buildApp({
  db,
  keyring,
  adminToken: env.ADMIN_TOKEN,
  logLevel: env.LOG_LEVEL,
  maxEventPayloadBytes: env.MAX_EVENT_PAYLOAD_BYTES,
  allowFullPayloadCapture: env.ALLOW_FULL_PAYLOAD_CAPTURE,
  replayAllowedHosts: env.REPLAY_ALLOWED_HOSTS
});

const retention = startRetentionJob(app);

// Warned at every boot, not once: an operator who scrolls past this on day one
// should meet it again on day thirty. It does not refuse to start, because the
// demo has to run with nothing configured.
for (const finding of findInsecureDefaults(process.env)) {
  app.log.warn({ variable: finding.variable }, finding.message);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  retention.stop();
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

// After listening, and not awaited by it: counting a large table must not
// delay readiness, and the check never throws.
void checkKeysAtBoot(db, keyring, app.log);
