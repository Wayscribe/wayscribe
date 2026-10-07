import { listProjects } from "@wayscribe/database";
import type { FastifyInstance } from "fastify";
import { bearerToken } from "../auth.js";
import { constantTimeEquals } from "../principal.js";

/**
 * The one route that answers "which projects exist?".
 *
 * It cannot go through `resolvePrincipal`, because that resolves an admin to a
 * *named* project and 404s when none was named and there is more than one —
 * which is exactly the situation a caller is in when it asks this question.
 * Chicken and egg: the interface needs the list before it can name one.
 *
 * Admin and reader only. A reader lists projects as an admin does, to choose
 * one (ADR-070). An API key is scoped to a single project by construction, so it
 * has nothing to choose between, and enumerating an installation's projects is
 * an operator action.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  adminToken: string,
  /** READ_TOKEN: a reader lists projects as an admin does, to choose one (ADR-070). */
  readToken?: string
): void {
  app.get("/v1/projects", async (request, reply) => {
    const presented = bearerToken(request.headers.authorization);
    const allowed =
      presented !== undefined &&
      (constantTimeEquals(presented, adminToken) ||
        (readToken !== undefined && constantTimeEquals(presented, readToken)));

    if (!allowed) {
      // Same 401 for a wrong token and for a valid API key: telling an
      // API-key holder that this endpoint exists but is not for them is a
      // disclosure with no benefit.
      request.recordAuthenticationFailure();
      return reply.code(401).send(unauthorized(request.id));
    }

    const projects = await listProjects(app.db);
    return reply.send({ data: { items: projects } });
  });
}

function unauthorized(requestId: string): unknown {
  return {
    error: {
      code: "unauthorized",
      message: "An admin token is required.",
      requestId
    }
  };
}
