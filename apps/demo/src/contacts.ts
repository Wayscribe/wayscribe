import {
  invalidStatus,
  isSlowAccount,
  PHONE_REQUIRED,
  TARGET_STATUSES,
  TARGET_SLOW_RESPONSE_MS
} from "./failures.js";

export interface ContactResponse {
  /** How long the target takes before answering. */
  delayMs: number;
  status: number;
  body: unknown;
}

/**
 * The demo target's answer to `POST /contacts`, apart from the server so it can
 * be tested. Everything it does follows from the contact it was sent: it is
 * slow for the accounts `SLOW_ACCOUNT_PREFIX` marks, refuses a missing phone,
 * and refuses a `status` outside its enum.
 */
export function contactResponse(input: unknown): ContactResponse {
  const body = (typeof input === "object" && input !== null ? input : {}) as {
    externalId?: unknown;
    phone?: unknown;
    status?: unknown;
  };
  const delayMs = isSlowAccount(body.externalId) ? TARGET_SLOW_RESPONSE_MS : 0;

  if (body.phone === null || body.phone === undefined || body.phone === "") {
    return { delayMs, status: 422, body: { error: PHONE_REQUIRED } };
  }
  if (typeof body.status !== "string" || !TARGET_STATUSES.includes(body.status)) {
    return { delayMs, status: 422, body: { error: invalidStatus(String(body.status)) } };
  }

  const externalId = typeof body.externalId === "string" ? body.externalId : "unknown";
  return { delayMs, status: 201, body: { id: `contact_${externalId}` } };
}
