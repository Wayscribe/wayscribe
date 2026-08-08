/**
 * Headers that never travel with a replay.
 *
 * Its own list, not `DEFAULT_SECRET_PATHS`. That one is a *payload path* list
 * used for redacting recorded bodies, and it omits three of the eight headers
 * SECURITY.md section 8 requires blocked. Reusing it would have looked correct
 * and quietly let a webhook signature through.
 *
 * These are the credentials a recorded request carried when it was real. A
 * development destination must never receive them: they authenticate the
 * operator's production identity to whatever is listening.
 */
const BLOCKED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  // Cloud provider session tokens.
  "x-amz-security-token",
  // Webhook and payment-provider signatures. A replayed signature is either
  // invalid, in which case it is noise, or valid, in which case it authorises
  // something nobody intended.
  "x-hook-signature",
  "stripe-signature"
]);

/** Never overridden by a caller or a destination: Flight Recorder identifies itself. */
const USER_AGENT = "flight-recorder-replay";

export interface HeaderResult {
  headers: Record<string, string>;
  /** Names that were removed, for the audit record and the prepare screen. */
  blocked: string[];
}

/**
 * Build the headers a replay will send.
 *
 * Order matters: caller headers are filtered first, then the destination's own
 * configured headers are layered on. A destination's test credential is
 * configured deliberately by an operator, so it survives a name that would
 * otherwise be blocked — that is the "destination-specific test secret" of
 * SECURITY.md section 8, and the only way to authenticate to a development
 * endpoint that requires it.
 */
export function applyHeaderPolicy(
  requested: Record<string, string> | undefined,
  destinationHeaders: Record<string, string> | undefined
): HeaderResult {
  const headers: Record<string, string> = {};
  const blocked: string[] = [];

  for (const [name, value] of Object.entries(requested ?? {})) {
    const lower = name.toLowerCase();
    if (BLOCKED.has(lower)) {
      blocked.push(lower);
      continue;
    }
    // Header injection: a value carrying CR or LF splits the request.
    if (/[\r\n]/.test(value)) {
      blocked.push(lower);
      continue;
    }
    headers[lower] = value;
  }

  for (const [name, value] of Object.entries(destinationHeaders ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  headers["content-type"] = headers["content-type"] ?? "application/json";
  headers["user-agent"] = USER_AGENT;
  // States plainly, at the destination, that this request is not a real one.
  headers["x-flight-replay"] = "true";

  return { headers, blocked };
}

export const BLOCKED_HEADER_NAMES: readonly string[] = [...BLOCKED];
