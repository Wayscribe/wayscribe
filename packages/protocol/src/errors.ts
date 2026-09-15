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
