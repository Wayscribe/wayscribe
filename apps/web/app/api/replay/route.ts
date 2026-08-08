import { NextResponse, type NextRequest } from "next/server";
import { redirectTarget } from "../../../src/lib/redirect-url";
import { createReplay, listProjects } from "../../../src/lib/api";
import { webConfig } from "../../../src/lib/config";
import { SESSION_COOKIE_NAME, verifySession } from "../../../src/lib/session";

/**
 * Send a replay on behalf of the signed-in operator.
 *
 * A route handler rather than a server action because the prepare screen is a
 * plain HTML form: a failure has to land the browser back on a page, not render
 * a JSON error object.
 *
 * The session is verified here and not only in the layout. This is a write that
 * causes an outbound request, and a route handler is not covered by the route
 * group's gate.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session =
    cookie === undefined ? null : verifySession(config.ADMIN_TOKEN, cookie, Date.now());

  if (session === null) {
    return NextResponse.redirect(redirectTarget(request, "/login"), { status: 303 });
  }

  const form = await request.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };

  const journeyId = field("journeyId");
  const eventId = field("eventId");
  if (journeyId === "" || eventId === "") {
    return NextResponse.redirect(redirectTarget(request, "/"), { status: 303 });
  }

  const projectId = session.projectId === "" ? await onlyProject() : session.projectId;

  const result = await createReplay(
    {
      eventId,
      destinationId: field("destinationId"),
      path: field("path"),
      method: field("method") || "POST"
    },
    projectId
  );

  const back = redirectTarget(request, `/journeys/${journeyId}/replay`);
  back.searchParams.set("event", eventId);

  // A refused replay still produced a run, and its id is how the operator reads
  // the reason. Only a request that never became a run has nothing to show.
  if (result.data !== null) {
    back.searchParams.set("replay", result.data.id);
  } else if (result.error !== undefined) {
    back.searchParams.set("error", result.error.code);
  }

  return NextResponse.redirect(back, { status: 303 });
}

/** Mirrors the resolution in `requireProjectId` for the single-project install. */
async function onlyProject(): Promise<string> {
  const projects = await listProjects();
  return projects.length === 1 ? (projects[0]?.id ?? "") : "";
}
