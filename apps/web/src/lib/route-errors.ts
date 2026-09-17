import { NextResponse } from "next/server";
import { ApiUnavailableError, ProjectNotSelectedError } from "./api";

/** A `{ error: { code, message } }` body at the given HTTP status. */
export function jsonError(status: number, code: string, message: string): NextResponse {
  // A 404 is heuristically cacheable: an intermediary must not keep "no such
  // event" for an event that is about to be recorded.
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } }
  );
}

/** Turns the API client's typed failures into JSON responses; rethrows anything else. */
export function apiFailure(error: unknown): NextResponse {
  if (error instanceof ProjectNotSelectedError) {
    return jsonError(409, "project_not_selected", "Choose a project first.");
  }
  if (error instanceof ApiUnavailableError) {
    // The message names configuration (which container holds which token) and
    // belongs in the server log, not in a body served to a browser. Logging the
    // error itself, not just its message, keeps the stack and Node's `cause`
    // chain (the real ECONNREFUSED behind this error) in that log too.
    console.error(error);
    return jsonError(502, "api_unavailable", "The Wayscribe API is unavailable.");
  }
  throw error;
}
