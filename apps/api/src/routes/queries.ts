import {
  InvalidCursorError,
  findEventDetail,
  findJourneyDetail,
  listJourneyEvents,
  searchJourneys,
  type ReadScope
} from "@flight-recorder/database";
import { searchTokens, type Keyring } from "@flight-recorder/payload-security";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { databaseApiKeys, logVerifierReplaceFailure } from "../auth.js";
import {
  principalEnvironmentId,
  principalProjectId,
  resolvePrincipal,
  type Principal
} from "../principal.js";
import { presentAliases, presentEntityId } from "./present.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function registerQueryRoutes(
  app: FastifyInstance,
  keyring: Keyring,
  adminToken: string
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
        (request.headers["x-flight-project-id"] as string | undefined) ?? undefined
    });
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

  app.get("/v1/search", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const query = (request.query as { q?: string }).q?.trim();
    if (query === undefined || query === "") {
      return reply.code(400).send(errorBody("invalid_query", "q is required.", request.id));
    }

    try {
      const page = await searchJourneys(
        app.db,
        readScope(principal),
        query,
        // Both keys' tokens during a rotation, so rows not yet re-encrypted
        // are still found.
        searchTokens(keyring, query),
        parseLimit(request.query),
        (request.query as { cursor?: string }).cursor
      );

      return await reply.send({
        data: {
          items: page.items.map((hit) => ({
            journeyId: hit.journeyId,
            entity: {
              type: hit.entityType,
              id: presentEntityId(keyring, hit.encryptedPrimaryEntityId)
            },
            status: hit.status,
            eventCount: hit.eventCount,
            startedAt: hit.startedAt.toISOString(),
            lastEventAt: hit.lastEventAt.toISOString()
          })),
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
    const detail = await findJourneyDetail(app.db, readScope(principal), journeyId);
    // 404 rather than 403: confirming existence to an unauthorized caller is
    // itself a disclosure.
    if (detail === undefined) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }

    return reply.send({
      data: {
        journeyId: detail.journeyId,
        entity: {
          type: detail.entityType,
          id: presentEntityId(keyring, detail.encryptedPrimaryEntityId)
        },
        status: detail.status,
        aliases: presentAliases(keyring, detail.aliases),
        services: detail.services,
        eventCount: detail.eventCount,
        startedAt: detail.startedAt.toISOString(),
        completedAt: detail.completedAt?.toISOString() ?? null,
        lastEventAt: detail.lastEventAt.toISOString()
      }
    });
  });

  app.get("/v1/journeys/:journeyId/events", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;

    const { journeyId } = request.params as { journeyId: string };
    const journey = await findJourneyDetail(app.db, readScope(principal), journeyId);
    if (journey === undefined) {
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }

    try {
      const page = await listJourneyEvents(
        app.db,
        readScope(principal),
        journeyId,
        parseLimit(request.query),
        (request.query as { cursor?: string }).cursor
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
    const detail = await findEventDetail(app.db, readScope(principal), eventId);
    if (detail === undefined) {
      return reply.code(404).send(errorBody("not_found", "Event not found.", request.id));
    }

    return reply.send({
      data: {
        ...detail,
        eventTimestamp: detail.eventTimestamp.toISOString(),
        receivedAt: detail.receivedAt.toISOString()
      }
    });
  });
}

function parseLimit(query: unknown): number {
  const raw = (query as { limit?: string }).limit;
  const parsed = raw === undefined ? DEFAULT_LIMIT : Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
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
