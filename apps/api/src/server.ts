import { createKnexConfig } from "@wayscribe/database";
import knex from "knex";
import { buildApp } from "./app.js";
import { checkKeysAtBoot } from "./key-warnings.js";
import { startRetentionJob } from "./retention-job.js";
import { serveApi } from "./serve.js";
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

// The statement timeout applies to this pool only, so it covers every query
// the API runs (ingestion, reads, the retention sweep) and nothing the CLI runs.
const db = knex(
  createKnexConfig(env.DATABASE_URL, { statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS })
);
const app = buildApp({
  db,
  keyring,
  adminToken: env.ADMIN_TOKEN,
  logLevel: env.LOG_LEVEL,
  maxEventPayloadBytes: env.MAX_EVENT_PAYLOAD_BYTES,
  allowFullPayloadCapture: env.ALLOW_FULL_PAYLOAD_CAPTURE,
  replayAllowedHosts: env.REPLAY_ALLOWED_HOSTS,
  trustedProxyCount: env.TRUSTED_PROXY_COUNT
});

const retention = startRetentionJob(app);

// Warned at every boot, not once: an operator who scrolls past this on day one
// should meet it again on day thirty. It does not refuse to start, because the
// demo has to run with nothing configured. These are found in the values the
// API is running on, so a default reaching it through ENCRYPTION_KEY_FILE or
// ADMIN_TOKEN_FILE warns exactly as one in the environment does.
for (const finding of startup.insecureDefaults) {
  app.log.warn({ variable: finding.variable }, finding.message);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  retention.stop();
  // Closes the metrics listener too, through the hook serveApi registers.
  await app.close();
  await db.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  // 0.0.0.0 is correct inside a container; Compose restricts exposure by binding
  // published ports to 127.0.0.1 on the host, and publishes no metrics port.
  const serving = await serveApi(app, {
    port: env.PORT,
    host: "0.0.0.0",
    metricsPort: env.METRICS_PORT
  });
  if (serving.metricsAddress !== null) {
    app.log.info({ port: serving.metricsAddress.port }, "metrics listening at /metrics");
  }
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}

// After listening, and not awaited by it: counting a large table must not
// delay readiness, and the check never throws.
void checkKeysAtBoot(db, keyring, app.log, app.metrics);
