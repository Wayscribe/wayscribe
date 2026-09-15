/** Where the picker sends you when there is nowhere sensible to go back to. */
const HOME = "/";

const THROWAWAY_ORIGIN = "https://return-to.invalid";
/** A second, unrelated origin the final value is resolved against again. */
const SECOND_ORIGIN = "https://return-to-check.invalid";

/**
 * A destination carried through the project picker, reduced to something safe.
 *
 * The picker interrupts whatever you were doing — a search, usually — and the
 * query has to survive it, or you land back on an empty box and retype what you
 * already typed. Carrying it means the value round-trips through a form field,
 * so it arrives from the client and is not trustworthy.
 *
 * Anything that is not plainly a path inside this application becomes `/`.
 * Parsing against a throwaway origin is what catches the cases a `startsWith`
 * check misses: `//evil.test` is a protocol-relative URL, `/\evil.test` is
 * treated as one by browsers, and a tab or newline inside either is stripped
 * before the URL is resolved.
 *
 * Parsing is not enough on its own, because what is returned is the parsed
 * pathname, and parsing normalises. `/.//evil.test`, `/..//evil.test`,
 * `/%2e//evil.test` and `/a/..//evil.test` are all paths on the throwaway
 * origin whose pathname is `//evil.test`, and `/./\evil.test` becomes the same
 * once the backslash is read as a slash. Returned, that is a protocol-relative
 * URL again, and `redirectTarget` resolved it to http://evil.test. So a
 * pathname beginning with two separators is refused, and the value about to be
 * returned is resolved once more, against an unrelated origin, and must stay on
 * it.
 */
export function safeReturnTo(value: string | undefined): string {
  if (value === undefined) return HOME;

  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return HOME;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, THROWAWAY_ORIGIN);
  } catch {
    return HOME;
  }

  // Resolving moved it off the throwaway origin, so it was never a local path.
  if (parsed.origin !== THROWAWAY_ORIGIN) return HOME;

  // A pathname that begins with two separators is a protocol-relative URL the
  // moment it is used as one.
  if (/^[/\\]{2}/.test(parsed.pathname)) return HOME;

  // The picker returning to itself is a loop with no exit.
  if (parsed.pathname === "/projects") return HOME;

  // The fragment never reaches the server, so there is nothing to preserve and
  // one less place to hide something.
  const result = `${parsed.pathname}${parsed.search}`;
  return staysOn(result, SECOND_ORIGIN) ? result : HOME;
}

function staysOn(path: string, origin: string): boolean {
  try {
    return new URL(path, origin).origin === origin;
  } catch {
    return false;
  }
}
