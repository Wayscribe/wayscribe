import { NextResponse, type NextRequest } from "next/server";
import { seeOther } from "../../../src/lib/redirect-url";
import {
  ApiUnavailableError,
  createReplay,
  type PostResult,
  type ReplayRun
} from "../../../src/lib/api";
import { requestSession } from "../../../src/lib/request-session";
import { rejectCrossOrigin } from "../../../src/lib/same-origin";

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
  const refused = rejectCrossOrigin(request);
  if (refused !== null) return refused;

  const session = requestSession(request);

  if (session === null) {
    return seeOther("/login");
  }

  const form = await request.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };

  const journeyId = field("journeyId");
  const eventId = field("eventId");
  if (journeyId === "" || eventId === "") {
    return seeOther("/");
  }

  const projectId = session.projectId;

  const query = new URLSearchParams({ event: eventId });
  // Encoded: the journey id comes from the form, and an unencoded one could
  // carry a query or dot segments of its own.
  const replayPage = (): NextResponse =>
    seeOther(`/journeys/${encodeURIComponent(journeyId)}/replay?${query.toString()}`);

  let result: PostResult<ReplayRun>;
  try {
    result = await createReplay(
      {
        eventId,
        destinationId: field("destinationId"),
        path: field("path"),
        method: field("method") || "POST"
      },
      projectId
    );
  } catch (error) {
    // No answer arrived, so the page explains it, as the delete route's does,
    // rather than the browser showing a bare 500.
    query.set("error", failureCode(error));
    return replayPage();
  }

  // A refused replay still produced a run, and its id is how the operator reads
  // the reason. Only a request that never became a run has nothing to show.
  if (result.data !== null) {
    query.set("replay", result.data.id);
  } else {
    // An answer without the API's error body (a proxy's 502, say) still failed,
    // and the page has to say so rather than show the form as if nothing happened.
    query.set("error", result.error?.code ?? "unexpected");
  }

  return replayPage();
}

function failureCode(error: unknown): string {
  // Logged with its cause: the message can name configuration, which belongs
  // in the server log and not in the page.
  console.error(error);
  return error instanceof ApiUnavailableError ? "api_unavailable" : "unexpected";
}
