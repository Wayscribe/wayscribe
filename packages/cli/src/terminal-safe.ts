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

/** C0, DEL, C1, and the bidi embedding, override and isolate characters. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

const NAMED: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export function terminalSafe(text: string): string {
  return text.replace(UNSAFE, (character) => {
    const named = NAMED[character];
    if (named !== undefined) return named;
    const code = character.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    return code <= 0x7f ? `\\x${hex.padStart(2, "0")}` : `\\u{${hex}}`;
  });
}
