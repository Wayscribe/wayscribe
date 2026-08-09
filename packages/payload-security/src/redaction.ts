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
  checkLimits,
  type LimitResult,
  type LimitViolation,
  type Limits
} from "./limits.js";
export { CIRCULAR, REDACTED, redact } from "./redact.js";
export { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
export { toStorable, toStorableText } from "./storable.js";
