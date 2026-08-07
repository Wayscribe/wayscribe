/**
 * Redaction paths applied in every payload-bearing capture mode.
 *
 * This list cannot be disabled. SECURITY.md section 3 requires that
 * `full-payload` never mean "skip secret detection", so these apply even when an
 * operator has explicitly asked for full capture.
 *
 * Matching is case-insensitive, and the `*.name` form matches that key at any
 * single level, so `headers.authorization` and `request.authorization` are both
 * covered.
 */
export const DEFAULT_SECRET_PATHS: readonly string[] = [
  "authorization",
  "*.authorization",
  "proxy-authorization",
  "*.proxy-authorization",
  "cookie",
  "*.cookie",
  "set-cookie",
  "*.set-cookie",
  "x-api-key",
  "*.x-api-key",
  "password",
  "*.password",
  "access_token",
  "*.access_token",
  "refresh_token",
  "*.refresh_token",
  "client_secret",
  "*.client_secret",
  "api_key",
  "*.api_key",
  "secret",
  "*.secret"
];
