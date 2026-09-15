import { isStatementTimeout } from "@flight-recorder/database";
import type { Keyring } from "@flight-recorder/payload-security";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Knex } from "knex";
import { unknownKeyWarning } from "./key-warnings.js";
import { pathOf, serializeError, serializeRequest } from "./log-url.js";
import { createApiMetrics, type ApiMetrics } from "./metrics/api-metrics.js";
import { registerDeletionRoutes } from "./routes/deletions.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { registerReplayRoutes } from "./routes/replays.js";
import { errorBody } from "./admin.js";
import { registerAuthThrottle } from "./auth-throttle.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
    metrics: ApiMetrics;
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
  /** Recorded whether or not METRICS_PORT is set; the listener is what is optional. */
  metrics?: ApiMetrics;
  /**
   * From TRUSTED_PROXY_COUNT: how many proxies in front of the API append to
   * X-Forwarded-For. 0, the default, keys the client's address on the socket
   * and ignores the header, which any client can set.
   */
  trustedProxyCount?: number;
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
  const metrics = options.metrics ?? createApiMetrics(options.db);

  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
      // The default `req` serialiser logged `req.url` with its query string, so
      // a search wrote the searched identifier into every request log line.
      // The default `err` serialiser copied `rawPacket` from a request Node
      // could not parse, which is the request's bytes, bearer key included.
      serializers: { req: serializeRequest, err: serializeError },
      ...(options.logStream === undefined ? {} : { stream: options.logStream })
    },
    bodyLimit: options.bodyLimit ?? MAX_BATCH_EVENTS * maxEventPayloadBytes + BODY_LIMIT_HEADROOM,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    // A malformed percent-encoding (400) or a path parameter over
    // MAX_PARAM_LENGTH (414) is refused by the router before any route or hook
    // runs. Fastify's own answer quoted the path in its own shape, and no
    // onResponse hook saw it, so neither was counted.
    frameworkErrors: (error, request, reply) => {
      const tooLong = error.code === "FST_ERR_MAX_PARAM_LENGTH";
      const status = tooLong ? 414 : 400;
      metrics.observeRequest(request.method, undefined, status, reply.elapsedTime / 1000);
      // Typed for any route generic here; this reply has none.
      void (reply as unknown as FastifyReply)
        .code(status)
        .send(
          errorBody(
            tooLong ? "parameter_too_long" : "bad_url",
            tooLong
              ? "A path parameter is longer than any id the API accepts."
              : "The URL is not validly percent-encoded.",
            request.id
          )
        );
    }
  });

  // Counted in onResponse, once the status is final. The route label is the
  // pattern the router matched, never the path: `/v1/journeys/:journeyId` is
  // one series however many journeys are read, and a request that matched
  // nothing is `unmatched`, so a scanner walking random paths adds no series.
  app.addHook("onResponse", async (request, reply) => {
    metrics.observeRequest(
      request.method,
      request.routeOptions.url,
      reply.statusCode,
      reply.elapsedTime / 1000
    );
  });

  // Fastify's own not-found handler logged `Route GET:<url> not found` with the
  // query string, and echoed the URL in a body of its own shape. This logs
  // nothing beyond the request line, which the serialiser has made safe, and
  // answers in the API's error shape.
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(
        errorBody(
          "not_found",
          `No route matches ${request.method} ${pathOf(request.url)}.`,
          request.id
        )
      )
  );

  // One error shape for every failure, including the ones Fastify raises before
  // a route runs. Without this a 413 or a malformed-JSON 400 comes back in
  // Fastify's own shape, and a client parsing `error.code` finds nothing.
  app.setErrorHandler((error: unknown, request, reply) => {
    if (isStatementTimeout(error)) {
      const route = request.routeOptions.url;
      metrics.countQueryTimeout(route);
      // The route and request id only. The driver's error carries the SQL
      // text, and the request can carry the searched value; neither belongs
      // in a log line that exists to say a query was slow.
      app.log.warn(
        { route: route ?? "unmatched", requestId: request.id },
        "database statement cancelled by DATABASE_STATEMENT_TIMEOUT_MS"
      );
      return reply
        .code(503)
        .send(
          errorBody(
            "query_timeout",
            "The database took too long to answer and the query was cancelled. Try again, or narrow the request.",
            request.id
          )
        );
    }

    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const status = fastifyError.statusCode ?? 500;
    if (status >= 500) {
      app.log.error({ err: error, requestId: request.id }, "request failed");
    }

    return reply.code(status).send({
      error: {
        // A 5xx is always internal_error. The error's own code is kept only for
        // a client error Fastify raised, which carries a status of its own. A
        // database driver's error carries a SQLSTATE in `code` and no status,
        // and "22P02" is the database's vocabulary, not this API's contract.
        code:
          status >= 500
            ? "internal_error"
            : fastifyError.statusCode !== undefined && fastifyError.code !== undefined
              ? fastifyError.code
              : "bad_request",
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

  registerAuthThrottle(app, options.trustedProxyCount ?? 0);

  app.decorate("db", options.db);
  app.decorate("metrics", metrics);
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
