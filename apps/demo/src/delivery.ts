import {
  DELIVERY_TIMEOUT_MS,
  PERMANENT_TARGET_ERRORS,
  RETRY_DELAY_SECONDS,
  timeoutBackoffSeconds,
  type DeadLetterReason
} from "./failures.js";

/**
 * The worker's delivery decisions, apart from the queue and the recorder so
 * they can be tested without either.
 */

export interface DeliveryResult {
  status: number;
  body: unknown;
}

/** POST the customer to the target, giving up after `timeoutMs`. */
export async function postCustomer(
  targetUrl: string,
  customer: unknown,
  timeoutMs = DELIVERY_TIMEOUT_MS
): Promise<DeliveryResult> {
  const response = await fetch(`${targetUrl}/contacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(customer),
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { status: response.status, body: await response.json() };
}

function targetError(
  body: unknown
): { code?: unknown; message?: unknown; fields?: unknown } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "object" && error !== null ? error : undefined;
}

/** A 4xx whose error code says the same payload will always get the same answer. */
export function isPermanentRejection(result: DeliveryResult): boolean {
  if (result.status < 400 || result.status >= 500) return false;
  const code = targetError(result.body)?.code;
  return typeof code === "string" && PERMANENT_TARGET_ERRORS.includes(code);
}

/**
 * The fields the target named in its error body (ADR-072): its non-empty
 * strings, or undefined when it named none. The SDK bounds them again.
 */
export function rejectedFields(body: unknown): string[] | undefined {
  const fields = targetError(body)?.fields;
  if (!Array.isArray(fields)) return undefined;
  const named = fields.filter(
    (field): field is string => typeof field === "string" && field !== ""
  );
  return named.length === 0 ? undefined : named;
}

/** What `deliveryFailure` hands the SDK. */
export type DeliveryVerdict =
  boolean | { fields: string[] } | { message: string; code: string; fields?: string[] };

/**
 * The `isFailure` verdict for a delivery. A permanent rejection is recorded
 * with the target's own message and code, so the timeline says why nothing
 * was retried; any other failure keeps the SDK's generic text. Either way the
 * fields the target named ride along, so the failure can be linked to the
 * step that changed them (ADR-072).
 */
export function deliveryFailure(result: DeliveryResult): DeliveryVerdict {
  if (result.status < 400) return false;
  const fields = rejectedFields(result.body);
  if (!isPermanentRejection(result)) return fields === undefined ? true : { fields };
  const error = targetError(result.body);
  return {
    message:
      typeof error?.message === "string" ? error.message : "The target refused the customer.",
    code: typeof error?.code === "string" ? error.code : "result_failed",
    ...(fields === undefined ? {} : { fields })
  };
}

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export type DeliveryOutcome =
  { kind: "result"; result: DeliveryResult } | { kind: "threw"; error: unknown };

/** What the worker does with the message after an attempt. */
export type QueueAction =
  { kind: "delete" } | { kind: "retry"; visibilitySeconds: number; reason: DeadLetterReason };

export function nextAction(outcome: DeliveryOutcome, attempt: number): QueueAction {
  if (outcome.kind === "threw") {
    // A timeout backs off, doubling; anything else thrown (the target not up
    // yet) waits the queue's usual retry delay.
    return isTimeout(outcome.error)
      ? { kind: "retry", visibilitySeconds: timeoutBackoffSeconds(attempt), reason: "timeout" }
      : { kind: "retry", visibilitySeconds: RETRY_DELAY_SECONDS, reason: "rejected" };
  }
  // Success, or a rejection no retry can change: either way the message is done.
  if (outcome.result.status < 400 || isPermanentRejection(outcome.result)) {
    return { kind: "delete" };
  }
  return { kind: "retry", visibilitySeconds: RETRY_DELAY_SECONDS, reason: "rejected" };
}
