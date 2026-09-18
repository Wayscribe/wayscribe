import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listProjects } from "./api";
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
  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const adminToken = sessionAdminToken();
  const session = cookie === undefined ? null : verifySession(adminToken, cookie, Date.now());

  if (session === null) redirect("/login");
  if (session.projectId !== "") return session.projectId;

  const projects = await listProjects();
  if (projects.length === 1 && projects[0] !== undefined) return projects[0].id;

  // Carried so the picker can hand you back to what you were doing. Without
  // it, a search bounced through the picker and returned to an empty box.
  redirect(returnTo === undefined ? "/projects" : `/projects?next=${encodeURIComponent(returnTo)}`);
}
