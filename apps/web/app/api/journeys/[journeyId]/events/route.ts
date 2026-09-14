import { NextResponse, type NextRequest } from "next/server";
import { type EventsPageResponse, getJourney, listEvents } from "../../../../../src/lib/api";
import { apiFailure, jsonError } from "../../../../../src/lib/route-errors";
import { requestSession } from "../../../../../src/lib/request-session";

/**
 * One page of a journey's events for the browser.
 *
 * A proxy, not a new contract: the admin token is project-wide and stays on
 * the server (ADR-029), so the browser asks this handler and this handler asks
 * the API. The journey rides along so live mode can learn in one request that
 * the journey has finished.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ journeyId: string }> }
): Promise<NextResponse> {
  const session = requestSession(request);
  if (session === null) return jsonError(401, "unauthenticated", "Sign in again.");

  const { journeyId } = await params;
  const cursor = request.nextUrl.searchParams.get("cursor");

  try {
    const [page, journey] = await Promise.all([
      listEvents(journeyId, session.projectId, cursor),
      getJourney(journeyId, session.projectId)
    ]);
    if (page === null || journey === null) return jsonError(404, "not_found", "No such journey.");

    const body: EventsPageResponse = {
      items: page.items,
      nextCursor: page.nextCursor,
      journeyStatus: journey.status,
      journeyEventCount: journey.eventCount
    };
    return NextResponse.json(body);
  } catch (error) {
    return apiFailure(error);
  }
}
