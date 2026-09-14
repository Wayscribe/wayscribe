import { NextResponse } from "next/server";
import { ApiUnavailableError, ProjectNotSelectedError } from "./api";

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Turns the API client's typed failures into JSON responses; rethrows anything else. */
export function apiFailure(error: unknown): NextResponse {
  if (error instanceof ProjectNotSelectedError) {
    return jsonError(409, "project_not_selected", "Choose a project first.");
  }
  if (error instanceof ApiUnavailableError) {
    // The message names configuration (which container holds which token) and
    // belongs in the server log, not in a body served to a browser.
    console.error(error.message);
    return jsonError(502, "api_unavailable", "The Flight Recorder API is unavailable.");
  }
  throw error;
}
