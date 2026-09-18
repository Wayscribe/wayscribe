import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listProjects, type ProjectSummary } from "./api";
import { sessionAdminToken } from "./config";
import { SESSION_COOKIE_NAME, verifySession } from "./session";

/**
 * The project the current session reads from.
 *
 * Resolution order: whatever the session already chose, then "the only project"
 * when an installation has exactly one, then the picker.
 *
 * The middle case is what keeps the common install invisible — one project, no
 * selection, nothing to think about. It stops working the moment a second
 * project exists, which is why the third case has to exist: before it did, a
 * second project turned every search into "Nothing matched" with no explanation
 * and no way to recover from inside the interface.
 *
 * A page may name where it wants to return to after the picker; the value is
 * re-validated on the way back, because it round-trips through a form field.
 *
 * Pages call this, not the layout. The layout is the auth gate and cannot skip
 * itself for the picker page, which would then redirect to itself forever.
 */
export async function requireProjectId(returnTo?: string): Promise<string> {
  const resolved = await currentProject();
  if (resolved.kind !== "unchosen") return resolved.projectId;

  // Carried so the picker can hand you back to what you were doing. Without
  // it, a search bounced through the picker and returned to an empty box.
  redirect(returnTo === undefined ? "/projects" : `/projects?next=${encodeURIComponent(returnTo)}`);
}

/**
 * The project the current session reads from, resolved as `requireProjectId`
 * resolves it, but without sending the reader to the picker when none is
 * chosen. For a page that has something to show before a project is chosen:
 * the Search page's empty search box, which is where signing in lands.
 *
 * `projects` is the project list when resolving it had to fetch one, so a
 * caller that also needs the list does not ask the API for it twice; null
 * when the session had already chosen, and nothing was fetched.
 */
export type CurrentProject =
  | { kind: "chosen"; projectId: string; projects: null }
  | { kind: "only"; projectId: string; projects: ProjectSummary[] }
  | { kind: "unchosen"; projects: ProjectSummary[] };

export async function currentProject(): Promise<CurrentProject> {
  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  // No token means nothing can be verified, so nothing is: verifying against an
  // empty key would admit a cookie signed with an empty key, turning a
  // misconfiguration into a way in.
  const adminToken = sessionAdminToken();
  const session =
    adminToken === null || cookie === undefined
      ? null
      : verifySession(adminToken, cookie, Date.now());

  if (session === null) redirect("/login");
  if (session.projectId !== "") {
    return { kind: "chosen", projectId: session.projectId, projects: null };
  }

  const projects = await listProjects();
  if (projects.length === 1 && projects[0] !== undefined) {
    return { kind: "only", projectId: projects[0].id, projects };
  }
  return { kind: "unchosen", projects };
}
