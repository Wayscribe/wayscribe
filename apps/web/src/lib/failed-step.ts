/**
 * The step that failed a journey (ADR-063, F-047).
 *
 * A failed journey's `lastStep` is the step last in timeline order, which
 * while a retry is in flight is a later step that succeeded. The API's
 * `failedStep` names the failing step instead. An API older than ADR-063
 * omits it and a failure recorded before migration 021 has it null; both
 * read as no failed step, and the page shows what it showed before.
 *
 * Only a string is a failed step. Two paths send the value to the browser as
 * data: the events proxy's `journeyFailedStep` and JourneyTimeline's
 * `initialFailedStep` prop, and nothing but text crosses there
 * (`event-display.ts`). The Journeys table and search rows are server
 * components that render it into HTML, where anything but a string could
 * crash the render. The status is checked here too rather than trusting the
 * API to null the field outside `failed`.
 */
export function failedStepOf(journey: { status: string; failedStep?: unknown }): string | null {
  return journey.status === "failed" && typeof journey.failedStep === "string"
    ? journey.failedStep
    : null;
}

/** A status as a summary shows it: `failed at <step>` when the failed step is known. */
export function statusText(status: string, failedStep: string | null): string {
  return status === "failed" && failedStep !== null ? `failed at ${failedStep}` : status;
}
