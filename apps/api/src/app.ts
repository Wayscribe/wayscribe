import { isStatementTimeout } from "@wayscribe/database";
import { MAX_BATCH_EVENTS } from "@wayscribe/protocol";
import type { Keyring } from "@wayscribe/payload-security";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Knex } from "knex";
import { unknownKeyWarning } from "./key-warnings.js";
import { pathOf, serializeError, serializeRequest } from "./log-url.js";
import { createApiMetrics, type ApiMetrics } from "./metrics/api-metrics.js";
import { registerDeletionRoutes } from "./routes/deletions.js";
import { registerOtlpRoutes } from "./routes/otlp.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerQueryRoutes } from "./routes/queries.js";
import { registerReplayRoutes } from "./routes/replays.js";
import { errorBody } from "./admin.js";
import { registerAuthThrottle } from "./auth-throttle.js";
import type { RunningVersion } from "./version.js";

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
  /**
   * Per-request body cap. Defaults to the batch ceiling plus headroom.
   *
   * A batch is at most `MAX_BATCH_EVENTS` events and an event's payload at most
   * `MAX_EVENT_PAYLOAD_BYTES`, so the largest legitimate request is roughly the
   * product of the two. Fastify's 1 MiB default is far below that, which turns
   * a valid batch into a 413, and the SDK requeues a rejected batch to the
   * front of its queue, so an oversize batch head-of-line-blocks the recorder
   * until the queue trims. Sized from the contract rather than guessed.
   */
  bodyLimit?: number;
  otlpLogsEnabled?: boolean;
  otlpMaxRequestBytes?: number;
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
  /**
   * What `/ready` says this process is running. Defaults to what the image was
   * built as, falling back to the package version; a test injects one.
   */
  running?: RunningVersion;
}

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
 * The refusals that happen before a route runs, in codes this API owns.
 *
 * Fastify raises these from its content-type parser, and the error handler used
 * to publish its codes verbatim. That is the framework's vocabulary in a
 * document another implementation is meant to satisfy: it says that swapping
 * the web framework is a wire change, and it tells the author of a client in
 * another language to branch on a string that means nothing outside Node.
 *
 * The HTTP statuses are unchanged and are still the stable part, which is what
 * the ingestion contract tells a client to branch on. An empty body and a body
 * that is not JSON share one code: both mean the body could not be read, both
 * are a 400, and the message from Fastify already says which happened.
 *
 * Only these four are mapped, because only these four can actually be produced
 * by the ingestion routes; `apps/api/src/app.test.ts` sends each of them on both
 * routes and fails on any `FST_ERR` code that reaches a client.
 */
const TRANSPORT_CODES: Readonly<Record<string, string>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: "payload_too_large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
  FST_ERR_CTP_INVALID_JSON_BODY: "malformed_json",
  FST_ERR_CTP_EMPTY_JSON_BODY: "malformed_json"
};

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
  "req.headers['x-wayscribe-api-key']",
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
    // A recorded payload is evidence, and a key is part of it.
    //
    // Fastify parses with `secure-json-parse`, which by default throws on
    // `__proto__` and on `constructor.prototype` anywhere in the document. The
    // request came back 400 `FST_ERR_CTP_INVALID_JSON_BODY` — "Body is not
    // valid JSON" — about a body that is valid JSON, and the SDK treats a 4xx
    // as permanent, so a whole batch was discarded and never retried. The Node
    // SDK preserves a `__proto__` key on purpose
    // (`packages/payload-security/src/storable.ts`), so the recorder captured
    // the key faithfully and the server then refused every event sent with it.
    //
    // Safe to allow because the danger was never the parsing. `JSON.parse`
    // makes both names ordinary own data properties and leaves the object's
    // prototype alone; poisoning takes code that afterwards writes an
    // attacker-named key with `target[key] = value`. Every walk here that
    // rebuilds an object now uses `defineKey`, which was a claim before it was
    // a fact: the branch replacing a header pair's value still assigned, and
    // was unreachable for this key only because a third key exempted the object
    // from that branch, which was itself the redaction hole fixed beside it.
    // Zod's object schemas drop unknown keys, and `parseEnvelope` restores the
    // one key `z.record` loses. `apps/api/src/app.test.ts` asserts that
    // `Object.prototype` is untouched after both bodies are ingested.
    onProtoPoisoning: "ignore",
    onConstructorPoisoning: "ignore",
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
              ? (TRANSPORT_CODES[fastifyError.code] ?? fastifyError.code)
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

  registerAuthThrottle(app, { trustedProxyCount: options.trustedProxyCount ?? 0 });

  app.decorate("db", options.db);
  app.decorate("metrics", metrics);
  // One per app, and the API builds one app per process: each missing key id
  // is logged once however many reads meet it.
  const warnUnknownKey = unknownKeyWarning(app.log);
  registerHealthRoutes(app, options.running);
  registerEventRoutes(
    app,
    options.keyring,
    maxEventPayloadBytes,
    options.allowFullPayloadCapture ?? false
  );
  if (options.otlpLogsEnabled === true) {
    registerOtlpRoutes(app, {
      keyring: options.keyring,
      maxEventPayloadBytes,
      allowFullPayload: options.allowFullPayloadCapture ?? false,
      maxRequestBytes: options.otlpMaxRequestBytes ?? 4_194_304
    });
  }
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
