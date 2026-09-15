import { NextResponse, type NextRequest } from "next/server";
import { deleteJourney } from "../../../../../src/lib/api";
import { redirectTarget } from "../../../../../src/lib/redirect-url";
import { requestSession } from "../../../../../src/lib/request-session";
import { apiFailure, jsonError } from "../../../../../src/lib/route-errors";

/** What may name the deleted journey in the search page's notice. */
const PLAIN_ENTITY_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Delete one journey for the signed-in operator, from the confirmation page's form.
 *
 * The session is verified here: a route handler is not covered by the route
 * group's gate, and this is the one irreversible action in the interface.
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
  const session = requestSession(request);
  if (session === null) {
    return jsonError(401, "unauthorized", "Sign in again to delete a journey.");
  }

  const { journeyId } = await params;
  const form = await request.formData();
  const entityType = form.get("entityType");

  let outcome;
  try {
    outcome = await deleteJourney(journeyId, session.projectId);
  } catch (error) {
    return apiFailure(error);
  }
  if (outcome === "not_found") {
    return jsonError(404, "not_found", "That journey does not exist, or was already deleted.");
  }

  const target = redirectTarget(request, "/");
  target.searchParams.set(
    "deleted",
    typeof entityType === "string" && PLAIN_ENTITY_TYPE.test(entityType) ? entityType : "journey"
  );
  return NextResponse.redirect(target, { status: 303 });
}
