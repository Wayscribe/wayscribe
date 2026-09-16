import {
  findEventDetail,
  findJourneyDetail,
  isStatementTimeout,
  touchApiKey,
  type ApiKeyContext
} from "@flight-recorder/database";
import type { Keyring } from "@flight-recorder/payload-security";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { databaseApiKeys, logVerifierReplaceFailure, resolveApiKey } from "../auth.js";
import { ingestEvent, type IngestResult } from "../ingestion/ingest-event.js";
import { MAX_BATCH_EVENTS } from "@flight-recorder/protocol";
import type { EventResult } from "../metrics/api-metrics.js";
import { presentEvent, presentJourneyDetail } from "./present.js";

/**
 * How stale `last_used_at` is allowed to get.
 *
 * Ingestion is the hot path and a key is presented on every event, so writing
 * this row per request would add a write to a request that already has one. An
 * operator deciding whether a key is still in use does not need the last minute;
 * they need to know it was not last year.
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/**
 * Record that a key was used, at most once a minute, without blocking the reply.
 *
 * Errors are swallowed deliberately: failing an accepted ingestion because a
 * bookkeeping write failed would trade real data for a timestamp.
 */
function touch(app: FastifyInstance, id: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);

  void touchApiKey(app.db, id).catch((error: unknown) => {
    app.log.debug({ err: error }, "failed to record API key usage");
  });
}

interface BatchResult {
  eventId: string | null;
  status: "accepted" | "rejected";
  duplicate?: boolean;
  /** A dry run only: what this event would have stored, read inside the transaction. */
  stored?: { event: unknown; journey: unknown };
  /**
   * `httpStatus` is what the same rejection would have returned from the
   * single-event route. It rides along because the batch route always replies
   * 202 — the transport succeeded — and the client needs to tell a permanent
   * refusal (4xx, do not retry) from a transient one.
   */
  error?: {
    code: string | undefined;
    message: string | undefined;
    httpStatus: number;
    details?: { path: string; message: string }[];
  };
}

export function registerEventRoutes(
  app: FastifyInstance,
  keyring: Keyring,
  maxEventPayloadBytes: number,
  allowFullPayload: boolean
): void {
  const apiKeys = databaseApiKeys(app.db, keyring, logVerifierReplaceFailure(app.log));

  app.post("/v1/events", async (request, reply) => {
    // This route takes no query parameters at all, and `dryRun` is named in the
    // message because sending it here is the mistake worth explaining.
    const query = checkQuery(request.query, []);
    if (!query.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            "invalid_query",
            query.key.toLowerCase() === "dryrun"
              ? "dryRun is only available on POST /v1/events/batch. This route always stores."
              : query.message,
            request.id
          )
        );
    }

    const auth = await resolveApiKey(request.headers.authorization, apiKeys);
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    touch(app, auth.context.id);

    let result: IngestResult;
    try {
      result = await ingestEvent(
        app.db,
        keyring,
        auth.context,
        request.body,
        maxEventPayloadBytes,
        allowFullPayload
      );
    } catch (error) {
      // Not stored, so counted as rejected, the same as the batch route counts
      // a storage failure.
      app.metrics.countEvent("rejected");
      // Text PostgreSQL cannot store is the client's payload, and is answered
      // exactly as the batch route answers it. Everything else, a statement
      // timeout included, is the error handler's.
      if (isStatementTimeout(error)) throw error;
      const rejection = storageRejection(error);
      if (rejection.code !== "unstorable_payload") throw error;
      return reply
        .code(rejection.httpStatus)
        .send(errorBody(rejection.code, rejection.message ?? "", request.id));
    }
    app.metrics.countEvent(eventResult(result));
    if (result.status === "rejected") {
      return reply
        .code(result.httpStatus)
        .send(errorBody(result.code ?? "invalid_event", result.message ?? "", request.id));
    }

    return reply.code(202).send({
      data: {
        eventId: result.eventId,
        journeyId: result.journeyId,
        status: "accepted",
        duplicate: result.duplicate ?? false
      }
    });
  });

  app.post("/v1/events/batch", async (request, reply) => {
    const query = checkQuery(request.query, ["dryRun"]);
    if (!query.ok) {
      return reply.code(400).send(errorBody("invalid_query", query.message, request.id));
    }

    const dryRun = parseDryRun(request.query);
    if (!dryRun.ok) {
      return reply.code(400).send(errorBody("invalid_query", dryRun.message, request.id));
    }

    const auth = await resolveApiKey(request.headers.authorization, apiKeys);
    if (!auth.ok) {
      return reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
    }

    // A dry run is a key in use: it is what a conformance job in CI runs, and
    // leaving `last_used_at` stale would invite an operator to revoke the key
    // CI depends on. The verifier migration rides along for the same reason.
    // Both are about the key rather than about the events, and "nothing is
    // stored" means no event, journey, alias, summary or audit row.
    touch(app, auth.context.id);

    const body = request.body as { events?: unknown } | undefined;
    const events = body?.events;
    if (!Array.isArray(events)) {
      return reply
        .code(400)
        .send(errorBody("invalid_event", "Body must contain an events array.", request.id));
    }

    if (events.length > MAX_BATCH_EVENTS) {
      // Rejected before any event is processed, per SECURITY.md section 11.
      return reply
        .code(400)
        .send(
          errorBody(
            "payload_too_large",
            `A batch may contain at most ${String(MAX_BATCH_EVENTS)} events.`,
            request.id
          )
        );
    }

    const context = {
      app,
      keyring,
      request,
      auth: auth.context,
      maxEventPayloadBytes,
      allowFullPayload
    };

    if (!dryRun.value) {
      const results = await ingestBatch(context, app.db, events, false);
      return reply.code(202).send({ data: { results } });
    }

    const results = await previewBatch(context, events);
    // One line, because a dry run leaves no row behind and would otherwise be
    // entirely invisible to the operator whose data it probed. No values, and
    // no ids from the events.
    app.log.info(
      {
        requestId: request.id,
        apiKeyId: auth.context.id,
        events: results.length,
        accepted: results.filter((one) => one.status === "accepted").length,
        rejected: results.filter((one) => one.status === "rejected").length
      },
      "dry-run batch validated, nothing stored"
    );
    // 200 rather than 202: nothing was accepted for processing.
    return reply.code(200).send({ data: { dryRun: true, results } });
  });
}

/** Everything the batch loop needs that does not change between events. */
interface BatchContext {
  app: FastifyInstance;
  keyring: Keyring;
  request: FastifyRequest;
  auth: ApiKeyContext;
  maxEventPayloadBytes: number;
  allowFullPayload: boolean;
}

/**
 * Run the whole batch inside one transaction and roll it back before replying.
 *
 * A dry run is a real ingestion that is rolled back, not a second
 * implementation of the rules, and the reasons are specific. Only the insert
 * discovers `unstorable_payload`, since PostgreSQL is what refuses a NUL byte
 * or an unpaired surrogate and nothing in front of it does. `jsonb` settles key
 * order and duplicate keys, so a preview read back out of the transaction is
 * the stored form rather than a guess at it. And ordering inside a batch
 * matters: the same event id twice is an accept and a duplicate, and a journey
 * created by the first event is what the second is checked against, so per-event
 * isolation without a shared outer transaction would answer both differently.
 *
 * The rollback is unconditional. The results are carried out through a throw so
 * that knex rolls back on every path, including the one where an event threw
 * past the loop's own handler.
 */
async function previewBatch(context: BatchContext, events: unknown[]): Promise<BatchResult[]> {
  try {
    await context.app.db.transaction(async (trx) => {
      throw new DryRunFinished(await ingestBatch(context, trx, events, true));
    });
  } catch (error) {
    if (error instanceof DryRunFinished) return error.results;
    throw error;
  }
  // knex has already rejected with DryRunFinished by here; this satisfies the
  // return type rather than describing a reachable state.
  throw new Error("The dry-run transaction committed, which it must never do.");
}

/** Carries a finished dry run's results out through the rollback. */
class DryRunFinished extends Error {
  constructor(readonly results: BatchResult[]) {
    super("dry run finished");
    this.name = "DryRunFinished";
  }
}

async function ingestBatch(
  context: BatchContext,
  db: Knex,
  events: unknown[],
  preview: boolean
): Promise<BatchResult[]> {
  const { app, request } = context;
  const results: BatchResult[] = [];

  for (const event of events) {
    // Sequential and independent: one event's failure never affects another's.
    //
    // That was a claim rather than a fact until this try/catch existed. An
    // unstorable value — a NUL byte from a fixed-width export, a lone
    // surrogate from a sliced emoji — threw out of ingestEvent, escaped the
    // loop, and returned a 500 that discarded every event in the batch,
    // including the ones already stored.
    //
    // Under a dry run `db` is the outer transaction, so ingestEvent's own
    // `db.transaction` opens a savepoint: a throw rolls back that event alone
    // and leaves the outer transaction usable for the rest of the batch.
    let result;
    try {
      result = await ingestEvent(
        db,
        context.keyring,
        context.auth,
        event,
        context.maxEventPayloadBytes,
        context.allowFullPayload
      );
    } catch (error) {
      if (isStatementTimeout(error)) {
        // Answered per event, like any storage failure, but as a 503 so the
        // SDK retries it. Logged without the error, which carries the SQL.
        app.metrics.countQueryTimeout(request.routeOptions.url);
        app.log.warn(
          { route: request.routeOptions.url, requestId: request.id },
          "database statement cancelled by DATABASE_STATEMENT_TIMEOUT_MS"
        );
        result = QUERY_TIMEOUT_REJECTION;
      } else {
        app.log.warn({ err: error }, "event rejected by storage");
        result = storageRejection(error);
      }
    }

    // A validation is not an ingestion. An operator alerting on rejected events
    // must not be paged by a conformance suite that sends refusals on purpose.
    if (!preview) app.metrics.countEvent(eventResult(result));

    results.push(
      result.status === "accepted"
        ? {
            eventId: result.eventId,
            status: "accepted",
            duplicate: result.duplicate ?? false,
            ...(preview ? await previewStored(context, db, result) : {})
          }
        : {
            eventId: result.eventId,
            status: "rejected",
            error: {
              code: result.code,
              message: result.message,
              httpStatus: result.httpStatus,
              ...(result.details === undefined ? {} : { details: result.details })
            }
          }
    );
  }

  return results;
}

/**
 * What this event would have stored, read back inside the transaction.
 *
 * Through the same repository functions and the same presenters the read routes
 * use, so a conformance case can state an expected stored event against a shape
 * the API already publishes rather than against a private representation. It is
 * omitted for a duplicate, where nothing new would have been written.
 *
 * `receivedAt` is dropped: the row has one, because the insert really happened,
 * and it describes a moment that is about to be rolled away.
 */
async function previewStored(
  context: BatchContext,
  db: Knex,
  result: IngestResult
): Promise<{ stored?: { event: unknown; journey: unknown } }> {
  if (result.duplicate === true || result.eventId === null || result.journeyId === null) return {};

  const scope = { projectId: context.auth.projectId, environmentId: context.auth.environmentId };
  const [event, journey] = await Promise.all([
    findEventDetail(db, scope, result.eventId),
    findJourneyDetail(db, scope, result.journeyId)
  ]);
  if (event === undefined || journey === undefined) return {};

  const { receivedAt: _omitted, ...previewed } = presentEvent(event);
  return {
    stored: {
      event: previewed,
      journey: presentJourneyDetail(context.keyring, journey)
    }
  };
}

/**
 * Refuse any query key these routes do not know.
 *
 * `?dryrun=true` was ignored and the batch was stored: the parameter is read by
 * its exact name, so a misspelling meant a client believed it had validated a
 * batch it had in fact written. That is precisely the failure the single-event
 * route refuses `dryRun` to avoid, arriving by a different door.
 *
 * Refused rather than matched case-insensitively, which would have fixed
 * `dryrun` and not `dryRum`. Nothing legitimate adds a query parameter to
 * ingestion, so an unknown key is always a mistake worth reporting, and the
 * message names the key so the mistake is obvious.
 */
function checkQuery(
  query: unknown,
  known: readonly string[]
): { ok: true } | { ok: false; key: string; message: string } {
  for (const key of Object.keys(query ?? {})) {
    if (known.includes(key)) continue;
    const suggestion = known.find((name) => name.toLowerCase() === key.toLowerCase().trim());
    return {
      ok: false,
      key,
      message:
        suggestion === undefined
          ? `${key} is not a query parameter this route accepts.`
          : `${key} is not a query parameter this route accepts. Did you mean ${suggestion}?`
    };
  }
  return { ok: true };
}

/**
 * The `dryRun` query parameter: strictly `true` or `false`, and given once.
 *
 * Anything else is refused rather than read loosely. A client that wrote
 * `dryRun=1` and had it read as false would believe it had validated a batch it
 * had actually stored, and that silence is the failure mode this repository
 * keeps finding in its own history.
 */
function parseDryRun(
  query: unknown
): { ok: true; value: boolean } | { ok: false; message: string } {
  const raw = (query as { dryRun?: unknown }).dryRun;
  if (raw === undefined) return { ok: true, value: false };
  if (Array.isArray(raw)) return { ok: false, message: "dryRun must be given once." };
  if (raw === "true") return { ok: true, value: true };
  if (raw === "false") return { ok: true, value: false };
  return { ok: false, message: "dryRun must be true or false." };
}

function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}

/** A batch event whose statement ran past DATABASE_STATEMENT_TIMEOUT_MS: transient, so 503. */
const QUERY_TIMEOUT_REJECTION: IngestResult = {
  eventId: null,
  journeyId: null,
  status: "rejected",
  code: "query_timeout",
  message: "The database took too long to store the event and the statement was cancelled.",
  httpStatus: 503
};

function eventResult(result: IngestResult): EventResult {
  if (result.status === "rejected") return "rejected";
  return result.duplicate === true ? "duplicate" : "accepted";
}

/**
 * A storage failure, described without leaking the database's own vocabulary.
 *
 * A pg error carries `.code` — a SQLSTATE like `22P05` — and no `.statusCode`,
 * so the shared error handler used to publish it verbatim as the API's error
 * code. `22P05` tells an SDK user nothing; naming the likely cause tells them
 * where to look.
 *
 * `22P05` is a NUL in jsonb, `22021` a NUL in text, and `22P02` a lone
 * surrogate in jsonb, which `JSON.stringify` writes as a `\ud800` escape that
 * PostgreSQL's JSON parser refuses. `22P02` is also a malformed uuid, but every
 * uuid ingestion writes comes from the authenticated key's own row, so here it
 * can only be the payload.
 */
function storageRejection(error: unknown): IngestResult {
  const sqlState = (error as { code?: unknown } | null)?.code;
  const unsupportedText = sqlState === "22P05" || sqlState === "22021" || sqlState === "22P02";

  return {
    eventId: null,
    journeyId: null,
    status: "rejected",
    code: unsupportedText ? "unstorable_payload" : "storage_error",
    message: unsupportedText
      ? "The payload contains characters PostgreSQL cannot store, such as a NUL byte or an unpaired surrogate."
      : "The event could not be stored.",
    httpStatus: unsupportedText ? 400 : 500
  };
}
