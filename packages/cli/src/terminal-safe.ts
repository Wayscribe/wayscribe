/**
 * Server-supplied text made safe to print to a terminal.
 *
 * Event names, error messages, identifiers and payload values come from
 * whatever an instrumented service recorded. Printed raw, an ESC or C1
 * sequence can clear the screen, move the cursor or retitle the window, a
 * newline breaks the indented layout, and a bidi override reorders what the
 * reader sees (CVE-2021-42574). Each such character is shown as a visible
 * escape instead; everything else, including ordinary non-ASCII text, is
 * left alone.
 *
 * Callers that also bound a value bound it first and escape second, so a cap
 * can never cut an escape in half.
 */

/** C0, DEL, C1, and the bidi controls (U+061C, U+200E-200F, U+202A-202E, U+2066-2069). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/gu;

/** What `JSON.stringify` leaves raw: it escapes C0 itself. */
const UNSAFE_IN_JSON = /[\u007f-\u009f\p{Bidi_Control}]/gu;

const NAMED: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function escape(character: string): string {
  const named = NAMED[character];
  if (named !== undefined) return named;
  const code = character.codePointAt(0) ?? 0;
  const hex = code.toString(16);
  return code <= 0x7f ? `\\x${hex.padStart(2, "0")}` : `\\u{${hex}}`;
}

export function terminalSafe(text: string): string {
  return text.replace(UNSAFE, escape);
}

/**
 * `terminalSafe`, at most `width` UTF-16 units wide as `padEnd` counts them,
 * ending in `…` when cut. The cut falls between characters' escaped forms, so
 * it never splits an escape or a surrogate pair.
 */
export function terminalSafeWithin(text: string, width: number): string {
  const shown = terminalSafe(text);
  if (shown.length <= width) return shown;
  let kept = "";
  for (const character of text) {
    const piece = terminalSafe(character);
    if (kept.length + piece.length > width - 1) break;
    kept += piece;
  }
  return `${kept}…`;
}

/**
 * JSON text with the characters `JSON.stringify` leaves raw (DEL, C1, bidi
 * controls) written as `\uXXXX`. They can only sit inside strings, where that
 * escape means the same character, so the text parses to the same value and
 * stays copy-pasteable. Every one of them is in the BMP: four digits suffice.
 */
export function jsonSafe(json: string): string {
  return json.replace(
    UNSAFE_IN_JSON,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`
  );
}
