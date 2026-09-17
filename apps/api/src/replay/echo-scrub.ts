import { REDACTED } from "@wayscribe/payload-security";

/**
 * Values shorter than this are not replaced.
 *
 * A short value is as likely to be an ordinary word or number in the response
 * as an echo of the header, and replacing every `true` or `1234` in a body
 * would corrupt the result an operator is comparing. A credential worth
 * encrypting is longer than this.
 */
export const MIN_SCRUBBED_LENGTH = 8;

export interface EchoScrubber {
  /** Replace every occurrence within a string. */
  text: (value: string) => string;
  /** Replace within every string, and every object key, of a parsed JSON value. */
  value: (value: unknown) => unknown;
}

/**
 * Remove a destination's header values from what the destination sent back.
 *
 * The run stores request headers without their values, but a development
 * endpoint that echoes its request (a debug route, a framework error page)
 * would put the credential straight back into the stored response. This
 * replaces each exact value, and its JSON-escaped form, with `[REDACTED]`.
 *
 * Exact matching is the limit of what it can promise. A body cut at the
 * response size cap can end part way through a value, and that fragment is
 * not the value, so it is not replaced. An encoded echo (base64, URL-encoded
 * beyond JSON escaping) is not recognised either.
 */
export function echoScrubber(destinationValues: readonly string[]): EchoScrubber {
  const needles = new Set<string>();
  for (const value of destinationValues) {
    if (value.length < MIN_SCRUBBED_LENGTH) continue;
    needles.add(value);
    // A text body holding JSON carries the value escaped, which differs from
    // the raw value when it contains a quote, a backslash, or a control
    // character.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped.length >= MIN_SCRUBBED_LENGTH) needles.add(escaped);
  }
  // Longest first, so a value containing another is replaced whole rather than
  // leaving its remainder around the shorter one's marker.
  const ordered = [...needles].sort((a, b) => b.length - a.length);

  const text = (value: string): string => {
    let result = value;
    for (const needle of ordered) result = result.replaceAll(needle, REDACTED);
    return result;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        // Defined as an own property: `__proto__` from JSON.parse is an
        // ordinary key, and assignment would spend it on the prototype.
        Object.defineProperty(out, text(key), {
          value: walk(child),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      return out;
    }
    return value;
  };

  return { text, value: ordered.length === 0 ? (value) => value : walk };
}
