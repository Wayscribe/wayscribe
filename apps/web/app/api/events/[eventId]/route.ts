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
    // Same reasoning as `cache: "no-store"` in src/lib/api.ts: a debugging tool
    // showing another operator's stale event is worse than one that is
    // slightly slower, and without this a shared cache in front of a
    // self-hosted install would otherwise be free to store the response.
    return NextResponse.json(event, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
