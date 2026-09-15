import { REDACTED } from "@flight-recorder/payload-security";

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
  /** What goes out on the wire, with real values. Never persisted. */
  headers: Record<string, string>;
  /**
   * The same header names with every credential value replaced by `[REDACTED]`.
   * This is the only form a replay run may store or return.
   */
  recorded: Record<string, string>;
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

  // Names whose value the record must not hold. Every destination header is
  // one, whatever its name: an operator configures a destination header because
  // the destination needs it, which is what makes it a credential worth
  // encrypting at rest, and copying its decrypted value into a plain jsonb run
  // row would undo that encryption.
  const withheld = new Set<string>();

  for (const [name, value] of Object.entries(destinationHeaders ?? {})) {
    const lower = name.toLowerCase();
    headers[lower] = value;
    withheld.add(lower);
  }

  headers["content-type"] = headers["content-type"] ?? "application/json";
  headers["user-agent"] = USER_AGENT;
  // States plainly, at the destination, that this request is not a real one.
  headers["x-flight-replay"] = "true";
  // These two replaced whatever a destination configured under the same name,
  // so what was sent is Flight Recorder's own value and nothing is withheld.
  withheld.delete("user-agent");
  withheld.delete("x-flight-replay");

  const recorded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // A blocked name is redacted too even though a caller's copy was dropped
    // above: if one is present here it came from somewhere that deliberately
    // put it there, and it is a credential by name either way.
    recorded[name] = withheld.has(name) || BLOCKED.has(name) ? REDACTED : value;
  }

  return { headers, recorded, blocked };
}

export const BLOCKED_HEADER_NAMES: readonly string[] = [...BLOCKED];
