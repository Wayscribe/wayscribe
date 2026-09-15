import { findInsecureDefaults, loadServerEnv } from "@flight-recorder/config";
import { createKnexConfig } from "@flight-recorder/database";
import { createKeyring } from "@flight-recorder/payload-security";
import knex from "knex";
import { buildApp } from "./app.js";
import { startRetentionJob } from "./retention-job.js";

// Parsed before anything else, so a misconfigured process fails immediately with
// a message naming the offending variable rather than at first use.
const env = loadServerEnv(process.env);

const db = knex(createKnexConfig(env.DATABASE_URL));
// Built once, before anything listens. During a rotation the previous key is
// held beside the current one so data written under it stays readable; a
// previous key equal to the current one throws here rather than starting a
// rotation that rotates nothing.
const keyring = createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
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
