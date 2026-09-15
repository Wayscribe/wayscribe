import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveAdminProjectId } from "./principal.js";

/** The API's one error shape. */
export function errorBody(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}

/**
 * Authenticates the admin token and resolves the project it names.
 *
 * Resolves to the project id, or to undefined once it has sent the refusal.
 */
export type AdminGuard = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<string | undefined>;

/**
 * The gate for routes only an operator may call: replay (ADR-032) and deletion.
 *
 * It refuses an API key outright rather than resolving it to a principal. An
 * API key lives in application configuration on servers many people can reach
 * and exists to write events; a leaked one must not be able to send requests
 * from Flight Recorder or delete what it recorded.
 *
 * One definition shared by every admin-only route, so the 401 an API key gets
 * cannot drift between them.
 */
export function adminGuard(app: FastifyInstance, adminToken: string): AdminGuard {
  return async (request, reply) => {
    const [scheme, presented] = request.headers.authorization?.split(" ") ?? [];
    if (
      scheme?.toLowerCase() !== "bearer" ||
      presented === undefined ||
      !constantTimeEquals(presented, adminToken)
    ) {
      // The same 401 for a missing token, a wrong admin token, and a valid API
      // key. Telling a key holder that this endpoint exists but is not for them
      // discloses something and buys nothing.
      await reply
        .code(401)
        .send(errorBody("unauthorized", "An admin token is required.", request.id));
      return undefined;
    }

    const projectId = await resolveAdminProjectId(
      app.db,
      single(request.headers["x-flight-project-id"])
    );
    if (projectId === undefined) {
      await reply
        .code(404)
        .send(
          errorBody(
            "project_not_found",
            "Specify a project: none was named and there is not exactly one.",
            request.id
          )
        );
      return undefined;
    }
    return projectId;
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
