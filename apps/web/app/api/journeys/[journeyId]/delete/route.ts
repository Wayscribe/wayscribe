import { NextResponse, type NextRequest } from "next/server";
import {
  ApiUnavailableError,
  ProjectNotSelectedError,
  deleteJourney
} from "../../../../../src/lib/api";
import { redirectTarget } from "../../../../../src/lib/redirect-url";
import { requestSession } from "../../../../../src/lib/request-session";
import { rejectCrossOrigin } from "../../../../../src/lib/same-origin";

/** What may name the deleted journey in the search page's notice. */
const PLAIN_ENTITY_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Delete one journey for the signed-in operator, from the confirmation page's form.
 *
 * The session is verified here: a route handler is not covered by the route
 * group's gate, and this is the one irreversible action in the interface.
 *
 * Every outcome is a redirect, because the caller is a plain HTML form and a
 * JSON body would render as a raw object in the browser.
 *
 * The redirect names the entity type and nothing else. The entity id is often
 * personal data (an email, a customer number), and a query string is kept in
 * browser history and in access logs, which is the opposite of what deleting
 * the journey was for.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ journeyId: string }> }
): Promise<NextResponse> {
  const refused = rejectCrossOrigin(request);
  if (refused !== null) return refused;

  const session = requestSession(request);
  if (session === null) {
    return NextResponse.redirect(redirectTarget(request, "/login"), { status: 303 });
  }

  const { journeyId } = await params;
  const form = await request.formData();
  const entityType = form.get("entityType");

  let outcome: "deleted" | "not_found";
  try {
    outcome = await deleteJourney(journeyId, session.projectId);
  } catch (error) {
    const back = redirectTarget(request, `/journeys/${encodeURIComponent(journeyId)}/delete`);
    back.searchParams.set("error", failureCode(error));
    return NextResponse.redirect(back, { status: 303 });
  }

  const target = redirectTarget(request, "/");
  // Already gone, most often the second POST of a double click: the operator
  // wanted it deleted and it is, so the answer is the same notice.
  target.searchParams.set(
    "deleted",
    outcome === "deleted" && typeof entityType === "string" && PLAIN_ENTITY_TYPE.test(entityType)
      ? entityType
      : "journey"
  );
  return NextResponse.redirect(target, { status: 303 });
}

function failureCode(error: unknown): string {
  if (error instanceof ProjectNotSelectedError) return "project_not_selected";
  // Logged with its cause: the message can name configuration, which belongs
  // in the server log and not in the page.
  console.error(error);
  return error instanceof ApiUnavailableError ? "api_unavailable" : "unexpected";
}
