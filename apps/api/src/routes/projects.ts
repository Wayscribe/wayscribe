import { listProjects } from "@flight-recorder/database";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { bearerToken } from "../auth.js";

/**
 * The one route that answers "which projects exist?".
 *
 * It cannot go through `resolvePrincipal`, because that resolves an admin to a
 * *named* project and 404s when none was named and there is more than one —
 * which is exactly the situation a caller is in when it asks this question.
 * Chicken and egg: the interface needs the list before it can name one.
 *
 * Admin only. An API key is scoped to a single project by construction, so it
 * has nothing to choose between, and enumerating an installation's projects is
 * an operator action.
 */
export function registerProjectRoutes(app: FastifyInstance, adminToken: string): void {
  app.get("/v1/projects", async (request, reply) => {
    const presented = bearerToken(request.headers.authorization);

    if (presented === undefined || !constantTimeEquals(presented, adminToken)) {
      // Same 401 for a wrong admin token and for a valid API key: telling an
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

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
