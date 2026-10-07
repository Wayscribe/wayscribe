import type { FastifyInstance } from "fastify";
import { errorBody } from "./admin.js";
import { bearerToken } from "./auth.js";
import { constantTimeEquals } from "./principal.js";

/**
 * Every route a reader may call, as `METHOD /pattern` (ADR-070).
 *
 * An allowlist, not a denylist: a route added later is refused to a reader
 * until it is added here on purpose. `reader-allowlist.test.ts` calls every
 * registered route with the read token and fails on any that gets past the
 * guard without being listed. A `HEAD` request is checked as its `GET`.
 *
 * `/health` and `/ready` take no credential at all; they are listed so that
 * presenting the read token to them is not a refusal.
 */
export const READER_ROUTES: ReadonlySet<string> = new Set([
  "GET /health",
  "GET /ready",
  "GET /v1/projects",
  "GET /v1/search",
  "GET /v1/journeys",
  "GET /v1/journeys/:journeyId",
  "GET /v1/journeys/:journeyId/events",
  "GET /v1/events/:eventId"
]);

/** Whether a reader may call the route a request matched. Unmatched requests reach the 404 handler. */
export function readerMayCall(method: string, routeUrl: string | undefined): boolean {
  if (routeUrl === undefined) return true;
  return READER_ROUTES.has(`${method === "HEAD" ? "GET" : method} ${routeUrl}`);
}

/**
 * Refuse the read token on every route outside the allowlist, before the route
 * runs. Root-level, so it covers routes registered inside plugins (OTLP) too,
 * and runs before their own hooks.
 *
 * 403 rather than the 401 an API key gets from an admin route: the token is
 * valid, and the operator who issued it should be able to tell "this token
 * cannot do that" from "this token is wrong". It is not an authentication
 * failure, so the throttle does not count it.
 */
export function registerReaderGuard(app: FastifyInstance, readToken: string | undefined): void {
  if (readToken === undefined) return;
  app.addHook("onRequest", async (request, reply) => {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined || !constantTimeEquals(presented, readToken)) return;
    if (readerMayCall(request.method, request.routeOptions.url)) return;
    await reply
      .code(403)
      .send(
        errorBody(
          "forbidden",
          "The read-only token may call search and read routes only.",
          request.id
        )
      );
  });
}
