import { NextResponse, type NextRequest } from "next/server";
import { getEvent } from "../../../../src/lib/api";
import { apiFailure, jsonError } from "../../../../src/lib/route-errors";
import { requestSession } from "../../../../src/lib/request-session";

/**
 * One event's detail for the browser: payloads, diff, error. Same proxy
 * reasoning as the events page handler (ADR-029).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
): Promise<NextResponse> {
  const session = requestSession(request);
  if (session === null) return jsonError(401, "unauthenticated", "Sign in again.");

  const { eventId } = await params;
  try {
    const event = await getEvent(eventId, session.projectId);
    if (event === null) return jsonError(404, "not_found", "No such event.");
    return NextResponse.json(event);
  } catch (error) {
    return apiFailure(error);
  }
}
