/**
 * A key name reduced to what identifies it, ignoring how it was written.
 *
 * `apiKey`, `api_key`, `api-key` and `APIKey` are one name in four
 * conventions, and a payload usually contains whichever one its author
 * preferred. Matching the literal spelling meant the built-in list caught
 * `api_key` and `access_token` while storing `apiKey` and `accessToken` in the
 * clear — most of what a JavaScript payload actually holds.
 *
 * Only case and separators are removed. `secret` still does not match
 * `secretary`, because the point is one name spelled differently, not one name
 * resembling another.
 *
 * A module of its own so that redaction and the secret-name heuristic, which
 * redaction calls, can both use it without importing each other.
 */
export function normaliseName(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes("_") || lower.includes("-") ? lower.replace(/[-_]/g, "") : lower;
}
