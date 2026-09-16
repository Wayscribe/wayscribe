/**
 * Stable machine-readable error codes (EVENT_PROTOCOL.md section 12).
 *
 * These are a public contract. Human-readable messages may change freely;
 * these strings may not.
 *
 * Every code here is one ingestion actually sends. `missing_required_field`,
 * `invalid_timestamp` and `invalid_operation` were listed here and never
 * emitted: each of those conditions comes back as `invalid_event` with
 * the failing field in `details`. They were removed rather than reserved
 * (ADR-049), because a published registry that lists codes nothing sends tells
 * the author of a second SDK to branch on something that never arrives. A
 * client treats a code it does not know by its HTTP status, so a code added
 * later is still a compatible change.
 */
export const PROTOCOL_ERROR_CODES = {
  unsupportedProtocolVersion: "unsupported_protocol_version",
  invalidEvent: "invalid_event",
  payloadTooLarge: "payload_too_large",
  unauthorizedEnvironment: "unauthorized_environment",
  eventIdConflict: "event_id_conflict",
  /** The journey id belongs to another environment of the project (ADR-038). */
  journeyEnvironmentMismatch: "journey_environment_mismatch"
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];

/**
 * One refusal the ingestion routes can send: its code, its status, whether a
 * client should send the event again, and what it means.
 *
 * The single registry `docs/INGESTION_CONTRACT.md` is checked against, row by
 * row, by `tests/docs-truth.test.ts`. The document and the code cannot drift,
 * because one of them is generated from the other in the reader's head and the
 * test fails when they stop agreeing.
 *
 * Every row is a refusal the routes can actually produce, measured rather than
 * assumed. `unserialisable_payload`, which `checkLimits` can return, is not here
 * because it cannot arise from a parsed request body: it exists for the SDK,
 * which calls the same function on host values that a JSON parser never
 * produced.
 */
export interface Refusal {
  code: string;
  status: number;
  /**
   * Whether the same event may be sent again.
   *
   * The rule a client implements: a per-event status below 500 is permanent and
   * that event is never sent again; 500 or above is transient. Every transient
   * row here is a 5xx, which `tests/docs-truth.test.ts` asserts.
   */
  transient: boolean;
  /** Whether the whole request is refused, or one event of a batch. */
  scope: "request" | "event";
  meaning: string;
}

/** The refusals that happen before a route runs, in codes this API owns. */
export const TRANSPORT_REFUSALS: readonly Refusal[] = [
  {
    code: "payload_too_large",
    status: 413,
    transient: false,
    scope: "request",
    meaning: "the request body exceeded the server's body limit"
  },
  {
    code: "unsupported_media_type",
    status: 415,
    transient: false,
    scope: "request",
    meaning: "the content type has no parser; send application/json"
  },
  {
    code: "malformed_json",
    status: 400,
    transient: false,
    scope: "request",
    meaning: "the body was empty, or was not valid JSON"
  }
];

/** The refusals a route sends, per event or for the whole request. */
export const INGESTION_REFUSALS: readonly Refusal[] = [
  {
    code: "invalid_event",
    status: 400,
    transient: false,
    scope: "event",
    meaning: "the event did not match protocol 0.1; `details` names the fields"
  },
  {
    code: "unsupported_protocol_version",
    status: 400,
    transient: false,
    scope: "event",
    meaning: "the envelope's version is not served"
  },
  {
    code: "payload_too_large",
    status: 400,
    transient: false,
    scope: "event",
    meaning:
      "the envelope exceeded `MAX_EVENT_PAYLOAD_BYTES`, or the batch exceeded `MAX_BATCH_EVENTS`"
  },
  {
    code: "max_depth_exceeded",
    status: 400,
    transient: false,
    scope: "event",
    meaning: "nesting beyond 32 levels"
  },
  {
    code: "max_keys_exceeded",
    status: 400,
    transient: false,
    scope: "event",
    meaning: "more than 1,000 keys or elements in one object or array"
  },
  {
    code: "max_string_length_exceeded",
    status: 400,
    transient: false,
    scope: "event",
    meaning: "a string beyond 65,536 UTF-16 code units"
  },
  {
    code: "unstorable_payload",
    status: 400,
    transient: false,
    scope: "event",
    meaning: "text PostgreSQL refuses: a NUL byte or an unpaired surrogate"
  },
  {
    code: "invalid_query",
    status: 400,
    transient: false,
    scope: "request",
    meaning:
      "a query parameter this route does not accept, or a `dryRun` that was not `true` or `false` or was given twice"
  },
  {
    code: "unauthorized_environment",
    status: 403,
    transient: false,
    scope: "event",
    meaning: "the key is not authorized for `event.environment`"
  },
  {
    code: "event_id_conflict",
    status: 409,
    transient: false,
    scope: "event",
    meaning: "the id is stored in this project with different content"
  },
  {
    code: "journey_environment_mismatch",
    status: 409,
    transient: false,
    scope: "event",
    meaning: "the journey id belongs to another environment of this project"
  },
  {
    code: "storage_error",
    status: 500,
    transient: true,
    scope: "event",
    meaning: "the database failed to store it; the batch route only"
  },
  {
    code: "query_timeout",
    status: 503,
    transient: true,
    scope: "event",
    meaning: "the statement ran past `DATABASE_STATEMENT_TIMEOUT_MS` and was cancelled"
  }
];
