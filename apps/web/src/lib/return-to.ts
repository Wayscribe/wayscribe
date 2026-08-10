/** Where the picker sends you when there is nowhere sensible to go back to. */
const HOME = "/";

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
 */
export function safeReturnTo(value: string | undefined): string {
  if (value === undefined) return HOME;

  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return HOME;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, "https://return-to.invalid");
  } catch {
    return HOME;
  }

  // Resolving moved it off the throwaway origin, so it was never a local path.
  if (parsed.origin !== "https://return-to.invalid") return HOME;

  // The picker returning to itself is a loop with no exit.
  if (parsed.pathname === "/projects") return HOME;

  // The fragment never reaches the server, so there is nothing to preserve and
  // one less place to hide something.
  return `${parsed.pathname}${parsed.search}`;
}
