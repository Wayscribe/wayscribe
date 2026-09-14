import { NextResponse, type NextRequest } from "next/server";
import { redirectTarget } from "../../../src/lib/redirect-url";
import { createReplay } from "../../../src/lib/api";
import { requestSession } from "../../../src/lib/request-session";

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
  const auth = await requestSession(request);

  if (auth === null) {
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

  const projectId = auth.projectId;

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
