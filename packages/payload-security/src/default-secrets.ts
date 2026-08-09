/**
 * Redaction paths applied in every payload-bearing capture mode.
 *
 * This list cannot be disabled. SECURITY.md section 3 requires that
 * `full-payload` never mean "skip secret detection", so these apply even when an
 * operator has explicitly asked for full capture.
 *
 * Every entry uses the any-depth form, because a secret is identified by the
 * name it is filed under and not by where it sits. This list previously paired
 * a bare name with its `*.name` form, which together reached the top level and
 * one below it and no further — so `config.headers.authorization`, the shape
 * every axios error carries, was stored in the clear, along with anything
 * inside an array. Twenty-two rules covered two levels; eleven cover all of
 * them.
 *
 * Breadth is a separate question from reach, and this list is deliberately
 * narrow: each name means a secret in essentially every payload it appears in.
 * A name that is sometimes a secret belongs in an operator's own `redact`
 * configuration, where over-redaction is their call to make.
 */
export const DEFAULT_SECRET_PATHS: readonly string[] = [
  "**.authorization",
  "**.proxy-authorization",
  "**.cookie",
  "**.set-cookie",
  "**.x-api-key",
  "**.password",
  "**.access_token",
  "**.refresh_token",
  "**.client_secret",
  "**.api_key",
  "**.secret"
];
