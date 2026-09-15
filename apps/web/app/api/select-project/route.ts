import { NextResponse, type NextRequest } from "next/server";
import { seeOther } from "../../../src/lib/redirect-url";
import { webConfig } from "../../../src/lib/config";
import { listProjects } from "../../../src/lib/api";
import { safeReturnTo } from "../../../src/lib/return-to";
import { SESSION_COOKIE_NAME, signSession } from "../../../src/lib/session";
import { requestSession } from "../../../src/lib/request-session";
import { rejectCrossOrigin } from "../../../src/lib/same-origin";

/**
 * Record which project the session reads from, and return where you were.
 *
 * The chosen ID is validated against the real list rather than trusted. The
 * cookie is signed, so a forged value cannot arrive this way — but the form
 * field can still name a project that was deleted between rendering and
 * submitting, and writing that into the session would produce a session that
 * 404s on every page with no way out.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const refused = rejectCrossOrigin(request);
  if (refused !== null) return refused;

  const config = webConfig();
  const now = Date.now();

  const session = requestSession(request, now);
  if (session === null) {
    return seeOther("/login");
  }

  const form = await request.formData();
  const field = form.get("projectId");
  const projectId = typeof field === "string" ? field : "";

  // Where the picker interrupted. Re-validated rather than trusted: it arrives
  // in a form field, so it is client input however it got there.
  const nextField = form.get("next");
  const next = safeReturnTo(typeof nextField === "string" ? nextField : undefined);

  const projects = await listProjects();
  if (!projects.some((project) => project.id === projectId)) {
    return seeOther("/projects");
  }

  const response = seeOther(next);
  response.cookies.set(
    SESSION_COOKIE_NAME,
    signSession(config.ADMIN_TOKEN, { projectId, expiresAt: session.expiresAt }),
    {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: Math.max(0, Math.floor((session.expiresAt - now) / 1000))
    }
  );
  return response;
}
