/**
 * Recognising headers that an HTTP client files somewhere other than an object
 * key.
 *
 * Name-based redaction matched keys, and three ordinary shapes carry headers
 * without one: a fetch or undici `[name, value]` tuple, Node's flat
 * `rawHeaders` list, and the serialised header block a `http.ClientRequest`
 * keeps in `_header`, which axios puts on `error.request`. The security review
 * stored all three verbatim in the default capture mode.
 *
 * Every shape is recognised narrowly. A pair or an interleaved list is read as
 * headers only when its structure says so, and only a header *line* inside a
 * header block is masked, never the rest of the string: ADR-046 rejected
 * masking every payload string by shape, because the identifiers this product
 * exists to show look like credentials.
 *
 * Nothing here decides which names are secret. The caller passes a predicate
 * over the same normalised names that key matching uses, so a built-in or a
 * configured any-depth rule covers these shapes exactly as it covers a key.
 */

/** `[name, value]`, as fetch, undici and `Object.entries` produce. */
export function isNamedPair(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

/**
 * Header names common enough that one of them marks a flat list as headers.
 *
 * A flat string array of even length whose even items are all tokens is still
 * most often just a list, `["apple", "banana"]`, so structure alone is not
 * enough: at least one name must be a header nearly every request carries.
 */
const KNOWN_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "authorization",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "date",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
  "transfer-encoding",
  "user-agent",
  "x-api-key",
  "x-forwarded-for",
  "x-request-id"
]);

/**
 * Node's `rawHeaders` shape: `[name, value, name, value, ...]`.
 *
 * Every item a string, an even length, every name a valid HTTP token (RFC 9110
 * section 5.6.2), and at least one name from {@link KNOWN_HEADER_NAMES}.
 */
export function isInterleavedHeaders(value: readonly unknown[]): value is string[] {
  if (value.length === 0 || value.length % 2 !== 0) return false;
  let known = false;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") return false;
    if (index % 2 !== 0) continue;
    if (!isToken(item)) return false;
    known ||= KNOWN_HEADER_NAMES.has(item.toLowerCase());
  }
  return known;
}

/**
 * The text with the value of every secret-named header line replaced.
 *
 * Applies only to text holding a CRLF, which is how an HTTP/1.1 header block is
 * delimited and how ordinary prose almost never is. Lines are read up to the
 * first empty line, the end of the header section, so a body following the
 * headers is left alone. A line counts only as `token: value`; a request or
 * status line never matches, and neither does anything else.
 *
 * The whole value goes, scheme word included: `Authorization: [REDACTED]`. That
 * also makes it idempotent, which it must be, since the SDK and the server both
 * apply it.
 */
export function maskHeaderLines(
  text: string,
  isSecretName: (name: string) => boolean,
  redacted: string
): string {
  if (!text.includes(CRLF)) return text;

  let output = "";
  let copied = 0;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const breakAt = text.indexOf(CRLF, lineStart);
    const lineEnd = breakAt === -1 ? text.length : breakAt;
    // An empty line after the first ends the header section. The first line
    // may be empty only in text that opens with a CRLF, which is not a block.
    if (lineEnd === lineStart && lineStart > 0) break;

    const valueStart = secretValueStart(text, lineStart, lineEnd, isSecretName);
    if (valueStart !== undefined && text.slice(valueStart, lineEnd) !== redacted) {
      output += text.slice(copied, valueStart) + redacted;
      copied = lineEnd;
    }

    if (breakAt === -1) break;
    lineStart = breakAt + CRLF.length;
  }

  return copied === 0 ? text : output + text.slice(copied);
}

const CRLF = "\r\n";

/**
 * Where the value of a `name: value` line starts when the name is secret and
 * the value is not empty; otherwise undefined.
 */
function secretValueStart(
  text: string,
  start: number,
  end: number,
  isSecretName: (name: string) => boolean
): number | undefined {
  let index = start;
  while (index < end && isTokenCharacter(text.charCodeAt(index))) index += 1;
  if (index === start || text[index] !== ":") return undefined;
  if (!isSecretName(text.slice(start, index))) return undefined;

  index += 1;
  while (index < end && (text[index] === " " || text[index] === "\t")) index += 1;
  return index === end ? undefined : index;
}

function isToken(value: string): boolean {
  if (value === "") return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isTokenCharacter(value.charCodeAt(index))) return false;
  }
  return true;
}

/** `tchar`: letters, digits, and ``!#$%&'*+-.^_`|~``. */
function isTokenCharacter(code: number): boolean {
  if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  return TOKEN_PUNCTUATION.includes(String.fromCharCode(code));
}

const TOKEN_PUNCTUATION = "!#$%&'*+-.^_`|~";
