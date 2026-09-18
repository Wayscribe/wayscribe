import {
  InvalidCursorError,
  findEventDetail,
  findJourneyDetail,
  listJourneyEvents,
  listJourneys,
  searchJourneys,
  type ReadScope
} from "@wayscribe/database";
import { searchTokens, type Keyring } from "@wayscribe/payload-security";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { databaseApiKeys, logVerifierReplaceFailure } from "../auth.js";
import {
  principalEnvironmentId,
  principalProjectId,
  resolvePrincipal,
  type Principal
} from "../principal.js";
import { presentEvent, presentJourneyDetail, presentJourneySummary } from "./present.js";
import { parseJourneyListQuery } from "./journey-list-query.js";
import { parseSearchQuery } from "./search-query.js";
import { TIMELINE_PARAMETERS, pageLimit, unknownKey } from "./query-params.js";

const NULL_BYTE = String.fromCharCode(0);

export function registerQueryRoutes(
  app: FastifyInstance,
  keyring: Keyring,
  adminToken: string,
  /** Told the id of a key a read needed and the keyring lacks. */
  warnUnknownKey: (keyId: string) => void
): void {
  const apiKeys = databaseApiKeys(app.db, keyring, logVerifierReplaceFailure(app.log));

  /** Returns undefined and sends the error response when authentication fails. */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<Principal | undefined> {
    const auth = await resolvePrincipal({
      db: app.db,
      apiKeys,
      adminToken,
      authorizationHeader: request.headers.authorization,
      requestedProjectId:
        (request.headers["x-wayscribe-project-id"] as string | undefined) ?? undefined
    });
    // Only a 401 is a refused credential: a 404 is an admin naming a project
    // that does not exist, and a failed lookup throws before reaching here.
    if (!auth.ok && auth.status === 401) request.recordAuthenticationFailure();
    if (!auth.ok) {
      await reply.code(auth.status).send(errorBody(auth.code, auth.message, request.id));
      return undefined;
    }
    return auth.principal;
  }

  /**
   * What this caller may read.
   *
   * Built in one place and passed to every read. It used to be constructed
   * inline for search and nowhere else, so the three routes that return
   * journeys, events and payloads filtered on project alone — and a key scoped
   * to development could fetch a production payload by id.
   */
  function readScope(principal: Principal): ReadScope {
    return {
      projectId: principalProjectId(principal),
      environmentId: principalEnvironmentId(principal)
    };
  }

  /**
   * One identifier, resolved against every kind of identifier it could be.
   *
   * `since`, `until` and `environment` are optional and narrow the same
   * journeys the list endpoint's bounds narrow. Without them the search spans
   * the project's whole history, which is what it has always done and what
   * F-028 found surprising: an alias value reused across runs returns every
   * journey that ever carried it.
   */
  app.get("/v1/search", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const parsed = parseSearchQuery(request.query, new Date());
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("invalid_query", parsed.message, request.id));
    }
    const query = parsed.query;
    const limit = pageLimit(queryParams(request.query));
    if (!limit.ok) {
      return reply.code(400).send(errorBody("invalid_query", limit.message, request.id));
    }

    try {
      const page = await searchJourneys(
        app.db,
        readScope(principal),
        query,
        // Both keys' tokens during a rotation, so rows not yet re-encrypted
        // are still found.
        searchTokens(keyring, query),
        parsed.filters,
        limit.value,
        cursorParam(request.query)
      );

      return await reply.send({
        data: {
          items: page.items.map((hit) => presentJourneySummary(keyring, hit, warnUnknownKey)),
          nextCursor: page.nextCursor
        }
      });
    } catch (error) {
      return cursorError(error, reply, request.id);
    }
  });

  /**
   * Journeys by last activity in a window, for an investigation that starts
   * from "what happened" or "what failed" rather than from an identifier.
   *
   * Scoped exactly as search is. An API key asking for another environment
   * gets an empty page, not an error, because outside its scope nothing exists.
   */
  app.get("/v1/journeys", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const parsed = parseJourneyListQuery(request.query, new Date());
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("invalid_query", parsed.message, request.id));
    }
    const limit = pageLimit(queryParams(request.query));
    if (!limit.ok) {
      return reply.code(400).send(errorBody("invalid_query", limit.message, request.id));
    }

    try {
      const page = await listJourneys(
        app.db,
        readScope(principal),
        parsed.filters,
        limit.value,
        cursorParam(request.query)
      );

      return await reply.send({
        data: {
          items: page.items.map((journey) =>
            presentJourneySummary(keyring, journey, warnUnknownKey)
          ),
          nextCursor: page.nextCursor
        }
      });
    } catch (error) {
      return cursorError(error, reply, request.id);
    }
  });

  app.get("/v1/journeys/:journeyId", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const { journeyId } = request.params as { journeyId: string };
    // No stored id holds a NUL, and PostgreSQL refuses one in a comparison:
    // the same answer as any id that does not exist.
    if (journeyId.includes(NULL_BYTE)) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }
    const detail = await findJourneyDetail(app.db, readScope(principal), journeyId);
    // 404 rather than 403: confirming existence to an unauthorized caller is
    // itself a disclosure.
    if (detail === undefined) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }

    return reply.send({ data: presentJourneyDetail(keyring, detail, warnUnknownKey) });
  });

  app.get("/v1/journeys/:journeyId/events", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const { journeyId } = request.params as { journeyId: string };
    if (journeyId.includes(NULL_BYTE)) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }
    const unknown = unknownKey(queryParams(request.query), TIMELINE_PARAMETERS, "this timeline");
    if (unknown !== undefined) {
      return reply.code(400).send(errorBody("invalid_query", unknown, request.id));
    }
    const limit = pageLimit(queryParams(request.query));
    if (!limit.ok) {
      return reply.code(400).send(errorBody("invalid_query", limit.message, request.id));
    }
    const journey = await findJourneyDetail(app.db, readScope(principal), journeyId);
    if (journey === undefined) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }

    try {
      const page = await listJourneyEvents(
        app.db,
        readScope(principal),
        journeyId,
        limit.value,
        cursorParam(request.query)
      );

      return await reply.send({
        data: {
          items: page.items.map((item) => ({
            ...item,
            eventTimestamp: item.eventTimestamp.toISOString(),
            receivedAt: item.receivedAt.toISOString()
          })),
          nextCursor: page.nextCursor
        }
      });
    } catch (error) {
      return cursorError(error, reply, request.id);
    }
  });

  app.get("/v1/events/:eventId", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const { eventId } = request.params as { eventId: string };
    if (eventId.includes(NULL_BYTE)) {
      return reply.code(404).send(errorBody("not_found", "Event not found.", request.id));
    }
    const detail = await findEventDetail(app.db, readScope(principal), eventId);
    if (detail === undefined) {
      return reply.code(404).send(errorBody("not_found", "Event not found.", request.id));
    }

    return reply.send({ data: presentEvent(keyring, detail, warnUnknownKey) });
  });
}

/** The parsed query string, as the parameter readers take it. */
function queryParams(query: unknown): Record<string, unknown> {
  return (query ?? {}) as Record<string, unknown>;
}

/**
 * The `cursor` parameter, once. A repeated one arrives as an array, and is
 * refused as a malformed cursor rather than handed to a decoder that expects a
 * string. Thrown inside each route's try, so `cursorError` answers it.
 */
function cursorParam(query: unknown): string | undefined {
  const cursor = (query as { cursor?: unknown }).cursor;
  if (cursor === undefined || typeof cursor === "string") return cursor;
  throw new InvalidCursorError("cursor may be given once.");
}

function cursorError(error: unknown, reply: FastifyReply, requestId: string): FastifyReply {
  if (error instanceof InvalidCursorError) {
    return reply.code(400).send(errorBody("invalid_cursor", error.message, requestId));
  }
  throw error;
}

function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}
