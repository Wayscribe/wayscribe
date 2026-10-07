import type { NextRequest } from "next/server";
import { webConfig } from "./config";
import { SESSION_COOKIE_NAME, type VerifiedSession } from "./session";
import { resolveSession } from "./web-session";

/**
 * The session behind a route handler request: a signed-in operator, or in
 * anonymous read-only mode any visitor as a reader.
 *
 * Route handlers are not covered by the route group's layout gate, so each one
 * verifies the cookie itself. This is the one place that does it.
 *
 * `projectId` is passed through as-is, including empty. The API already
 * performs the only-project fallback (`apps/api/src/principal.ts`,
 * `resolveAdminProject`) and answers `project_not_found` when several projects
 * exist and none was named, which the web client turns into
 * `ProjectNotSelectedError`. Resolving it again here would call `listProjects`
 * on every request for no different outcome — including the two-second poll
 * the events route handler makes.
 */
export function requestSession(request: NextRequest, now = Date.now()): VerifiedSession | null {
  // Loaded first so a misconfigured app still throws here, as it always has,
  // rather than reading as "not signed in".
  webConfig();
  return resolveSession(request.cookies.get(SESSION_COOKIE_NAME)?.value, now);
}
