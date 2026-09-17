const UNEXPECTED = "Something went wrong, so the replay may not have been sent. Try again.";

/**
 * What `/api/replay`'s `error` values mean to the operator.
 *
 * The keys are the codes this route can realistically get: the ones
 * `POST /v1/replays` answers with when no run was created
 * (apps/api/src/routes/replays.ts and the admin guard, throttle and error
 * handler it runs behind), plus the ones the route handler adds itself.
 * Anything else, such as a code a later API adds, falls back to the generic
 * message. A refused or failed run is not here: it has an id, and the replay
 * page reads its reason from the run.
 *
 * The text is fixed. The code arrives in the query string, which anyone can
 * write, so it only ever selects a message and is never shown.
 */
const FAILURES: Record<string, string> = {
  invalid_request:
    "The replay request was incomplete, so nothing was sent. Reload this page and try again.",
  invalid_method:
    "That method cannot be replayed, so nothing was sent. Choose POST, PUT, or PATCH.",
  not_found:
    "The step or the destination no longer exists, so nothing was sent. It may have been deleted since this page was loaded.",
  no_captured_input:
    "This step has no captured input, so nothing was sent. Its environment may be set to metadata-only capture.",
  destination_disabled:
    "That destination is disabled, so nothing was sent. Choose another destination.",
  project_not_found:
    "The API could not tell which project to use, so nothing was sent. Choose a project and try again.",
  unauthorized:
    "The API refused the web app's admin token, so nothing was sent. The web app and the API must be configured with the same ADMIN_TOKEN.",
  too_many_attempts:
    "The API is refusing this address after too many failed authentication attempts, so nothing was sent. Try again later.",
  query_timeout:
    "The database took too long to answer, so the replay may not have finished. Try again in a moment.",
  internal_error:
    "The API failed unexpectedly, so the replay may not have been sent. The API's log has the details.",
  // Also thrown when the answer is lost after the API has already sent the
  // replay, so this cannot promise that nothing went out.
  api_unavailable:
    "The Wayscribe API could not be reached, so the replay may or may not have been sent. Check whether the destination received it before trying again.",
  unexpected: UNEXPECTED
};

/** The message for a route handler `error` value. Anything unknown reads as `unexpected`. */
export function replayFailureMessage(code: string): string {
  // Own keys only: `constructor` or `toString` would otherwise find the
  // prototype's function instead of falling back.
  return (Object.hasOwn(FAILURES, code) ? FAILURES[code] : undefined) ?? UNEXPECTED;
}

/** A replay that never became a run, said the way the delete page says its failures. */
export function ReplayFailure({ code }: { code: string }) {
  return (
    <p className="error" role="alert">
      {replayFailureMessage(code)}
    </p>
  );
}
