/**
 * Client-safe subset of payload-security.
 *
 * The SDK is embedded in other companies' applications. It needs redaction and
 * size checks; it must not pull in AES encryption, API-key generation, or HMAC
 * search tokens, which are server-side concerns and pure bloat in a customer's
 * bundle.
 */
export {
  DEFAULT_LIMITS,
  PAYLOAD_DEPTH,
  checkLimits,
  eventLimits,
  payloadLimits,
  type LimitResult,
  type LimitViolation,
  type Limits
} from "./limits.js";
export {
  MAX_STRING_LENGTH,
  TRUNCATION_MARKER_PATTERN,
  truncateStrings,
  truncateText,
  truncationMarker,
  type TruncationStats
} from "./truncate.js";
export { CIRCULAR, REDACTED, redact } from "./redact.js";
export { maskSecretsInText } from "./mask-text.js";
export { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
export { looksLikeSecretName } from "./secret-name.js";
export { toStorable, toStorableText } from "./storable.js";
