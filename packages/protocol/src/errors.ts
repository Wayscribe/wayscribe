/**
 * Stable machine-readable error codes (EVENT_PROTOCOL.md section 12).
 *
 * These are a public contract. Human-readable messages may change freely;
 * these strings may not.
 */
export const PROTOCOL_ERROR_CODES = {
  unsupportedProtocolVersion: "unsupported_protocol_version",
  invalidEvent: "invalid_event",
  missingRequiredField: "missing_required_field",
  payloadTooLarge: "payload_too_large",
  unauthorizedEnvironment: "unauthorized_environment",
  invalidTimestamp: "invalid_timestamp",
  invalidOperation: "invalid_operation",
  eventIdConflict: "event_id_conflict",
  /** The journey id belongs to another environment of the project (ADR-038). */
  journeyEnvironmentMismatch: "journey_environment_mismatch"
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];
