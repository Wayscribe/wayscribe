import { NextResponse, type NextRequest } from "next/server";
import { redirectTarget } from "../../../src/lib/redirect-url";
import { webConfig } from "../../../src/lib/config";
import { listProjects } from "../../../src/lib/api";
import { SESSION_COOKIE_NAME, signSession, verifySession } from "../../../src/lib/session";

/**
 * Record which project the session reads from.
 *
 * The chosen ID is validated against the real list rather than trusted. The
 * cookie is signed, so a forged value cannot arrive this way — but the form
 * field can still name a project that was deleted between rendering and
 * submitting, and writing that into the session would produce a session that
 * 404s on every page with no way out.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  const now = Date.now();

  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = cookie === undefined ? null : verifySession(config.ADMIN_TOKEN, cookie, now);
  if (session === null) {
    return NextResponse.redirect(redirectTarget(request, "/login"), { status: 303 });
  }

  const form = await request.formData();
  const field = form.get("projectId");
  const projectId = typeof field === "string" ? field : "";

  const projects = await listProjects();
  if (!projects.some((project) => project.id === projectId)) {
    return NextResponse.redirect(redirectTarget(request, "/projects"), { status: 303 });
  }

  const response = NextResponse.redirect(redirectTarget(request, "/"), { status: 303 });
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
