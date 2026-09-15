import type { Keyring } from "@flight-recorder/payload-security";
import Fastify, { type FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { unknownKeyWarning } from "./key-warnings.js";
import { registerDeletionRoutes } from "./routes/deletions.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { registerReplayRoutes } from "./routes/replays.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
  }
}

export interface BuildAppOptions {
  db: Knex;
  /** Current key, and the previous one during a rotation's grace period. */
  keyring: Keyring;
  adminToken: string;
  logLevel?: string;
  /** Per-request body cap. Defaults to the batch ceiling plus headroom. */
  bodyLimit?: number;
  maxEventPayloadBytes?: number;
  allowFullPayloadCapture?: boolean;
  /** From REPLAY_ALLOWED_HOSTS. Empty means replay can reach nothing. */
  replayAllowedHosts?: readonly string[];
  /** Destination for log lines. Exists so a test can assert on what is written. */
  logStream?: { write: (line: string) => void };
}

/**
 * A batch is at most 100 events and an event's payload at most
 * `MAX_EVENT_PAYLOAD_BYTES`, so the largest legitimate request is roughly the
 * product of the two. Fastify's 1 MiB default is far below that, which turns a
 * valid batch into a 413 — and the SDK requeues a rejected batch to the front
 * of its queue, so an oversize batch head-of-line-blocks the recorder until the
 * queue trims. Sized from configuration rather than guessed.
 */
const MAX_BATCH_EVENTS = 100;

/**
 * Longest path parameter the router accepts, measured in the encoded path.
 *
 * Journey and event ids are up to 128 characters (packages/protocol), and a
 * character outside ASCII is up to nine once percent-encoded. Fastify's default
 * of 100 answered a legitimate long id with 414 before any route ran, so an
 * operator could record a journey and then neither read nor delete it by id.
 */
const MAX_PARAM_LENGTH = 128 * 9;
const BODY_LIMIT_HEADROOM = 64 * 1024;

/**
 * Log redaction paths.
 *
 * SECURITY.md section 12 requires that logs omit secrets. Fastify's default
 * request serialiser does not log headers, but an error path or a future
 * `req.headers` log line would, and the cost of listing them now is nothing.
 */
const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['x-flight-api-key']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie"
];

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const maxEventPayloadBytes = options.maxEventPayloadBytes ?? 262_144;

  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
      ...(options.logStream === undefined ? {} : { stream: options.logStream })
    },
    bodyLimit: options.bodyLimit ?? MAX_BATCH_EVENTS * maxEventPayloadBytes + BODY_LIMIT_HEADROOM,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH }
  });

  // One error shape for every failure, including the ones Fastify raises before
  // a route runs. Without this a 413 or a malformed-JSON 400 comes back in
  // Fastify's own shape, and a client parsing `error.code` finds nothing.
  app.setErrorHandler((error: unknown, request, reply) => {
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const status = fastifyError.statusCode ?? 500;
    if (status >= 500) {
      app.log.error({ err: error, requestId: request.id }, "request failed");
    }

    return reply.code(status).send({
      error: {
        code: fastifyError.code ?? (status >= 500 ? "internal_error" : "bad_request"),
        // A 500's message can carry internals; anything else is the client's
        // own mistake described back to them.
        message:
          status >= 500
            ? "An unexpected error occurred."
            : (fastifyError.message ?? "Bad request."),
        requestId: request.id
      }
    });
  });

  app.decorate("db", options.db);
  // One per app, and the API builds one app per process: each missing key id
  // is logged once however many reads meet it.
  const warnUnknownKey = unknownKeyWarning(app.log);
  registerHealthRoutes(app);
  registerEventRoutes(
    app,
    options.keyring,
    maxEventPayloadBytes,
    options.allowFullPayloadCapture ?? false
  );
  registerProjectRoutes(app, options.adminToken);
  registerQueryRoutes(app, options.keyring, options.adminToken, warnUnknownKey);
  registerReplayRoutes(app, {
    adminToken: options.adminToken,
    keyring: options.keyring,
    warnUnknownKey,
    allowedHosts: options.replayAllowedHosts ?? []
  });
  registerDeletionRoutes(app, { adminToken: options.adminToken, keyring: options.keyring });

  return app;
}
