import type { NextRequest } from "next/server";
import { listProjects } from "./api";
import { webConfig } from "./config";
import { SESSION_COOKIE_NAME, verifySession, type SessionPayload } from "./session";

export interface RequestSession {
  session: SessionPayload;
  /** Empty when several projects exist and the session has not chosen one. */
  projectId: string;
}

/**
 * The signed-in operator behind a route handler request, and their project.
 *
 * Route handlers are not covered by the route group's layout gate, so each one
 * verifies the cookie itself. This is the one place that does it, so a handler
 * cannot get the project resolution subtly different from the pages (which use
 * `requireProjectId`; the difference is that a handler cannot redirect to the
 * picker, so it reports an empty project instead).
 */
export async function requestSession(
  request: NextRequest,
  now = Date.now()
): Promise<RequestSession | null> {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = cookie === undefined ? null : verifySession(webConfig().ADMIN_TOKEN, cookie, now);
  if (session === null) return null;

  if (session.projectId !== "") return { session, projectId: session.projectId };

  const projects = await listProjects();
  const only = projects.length === 1 ? projects[0] : undefined;
  return { session, projectId: only?.id ?? "" };
}
