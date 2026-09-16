import { TRUNCATION_MARKER_PATTERN } from "./truncation-marker.js";

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
 * HAR files and Playwright's `headersArray` add a fourth, `{ name, value }` or
 * `{ key, value }` objects in an array.
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
 * The key holding the name, when the value is a plain object carrying a string
 * `name` (HAR) or `key` (Playwright) beside a `value`.
 *
 * This once required **exactly** those two keys, and a third key defeated the
 * rule completely: `{"name":"authorization","value":"Bearer …","other":1}` was
 * an ordinary object, no key on it is called a secret name, and the credential
 * was stored in the clear. HAR's own header object allows a `comment` beside
 * `name` and `value`, and a client that adds a `line` or an index does the same,
 * so the shape most likely to carry a real credential was the one exempted.
 *
 * The narrowness the key count bought was never what kept this from
 * reinterpreting arbitrary objects. That work is done by three things which
 * still hold: the name has to be a string, it has to normalise to a name
 * somebody called a secret, and a value that is itself a known header name is
 * left alone. Only the value is replaced; every other field is untouched.
 */
export function namedValueKey(value: unknown): "name" | "key" | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (!Object.hasOwn(value, "value")) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["name"] === "string") return "name";
  if (typeof record["key"] === "string") return "key";
  return undefined;
}

/**
 * Whether a value filed under a header's name is itself a header name.
 *
 * `allowedHeaders: ["Authorization", "Content-Type"]` and a `vary` list read as
 * name-value pairs, and replacing `Content-Type` after `Authorization` put a
 * change into the diff that nobody made. No credential is a header name, so a
 * value that is one is kept in every positional shape.
 */
export function isKnownHeaderName(value: unknown): boolean {
  return typeof value === "string" && KNOWN_HEADER_NAMES.has(value.toLowerCase());
}

/**
 * Header names common enough that one of them marks a flat list as headers.
 *
 * A flat string array of even length whose even items are all tokens is still
 * most often just a list, `["apple", "banana"]`, so structure alone is not
 * enough: at least one name must be a header nearly every request or response
 * carries. HTTP/2's pseudo-headers count, since nothing else is spelled that way.
 */
const KNOWN_HEADER_NAMES: ReadonlySet<string> = new Set([
  ":authority",
  ":method",
  ":path",
  ":protocol",
  ":scheme",
  ":status",
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
  "etag",
  "host",
  "if-none-match",
  "location",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
  "transfer-encoding",
  "user-agent",
  "vary",
  "www-authenticate",
  "x-api-key",
  "x-forwarded-for",
  "x-request-id"
]);

/**
 * Node's `rawHeaders` shape, from `node:http` and `node:http2` alike:
 * `[name, value, name, value, ...]`.
 *
 * Every item a string, an even length, every name a valid HTTP token (RFC 9110
 * section 5.6.2) or an HTTP/2 pseudo-header, `:` and a token, and at least one
 * name from {@link KNOWN_HEADER_NAMES}. HTTP/2 rawHeaders open with `:path` or
 * `:status`, and requiring plain tokens rejected every one of them, so their
 * `authorization` and `set-cookie` were stored verbatim.
 */
export function isInterleavedHeaders(value: readonly unknown[]): value is string[] {
  if (value.length === 0 || value.length % 2 !== 0) return false;
  let known = false;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") return false;
    if (index % 2 !== 0) continue;
    if (!isToken(item.startsWith(":") ? item.slice(1) : item)) return false;
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
  redacted: string,
  /** Told the name and value of each header line kept, for the secret-name warning. */
  onKept?: (name: string, value: string) => void
): string {
  // Text ending in the truncation marker counts as a block too: a client that
  // cut a block to its first line, and lost the only line break with it, must
  // not have that line escape masking.
  if (!text.includes(CRLF) && !TRUNCATION_MARKER_PATTERN.test(text)) return text;

  let output = "";
  let copied = 0;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const breakAt = text.indexOf(CRLF, lineStart);
    const lineEnd = breakAt === -1 ? text.length : breakAt;
    // An empty line after the first ends the header section. The first line
    // may be empty only in text that opens with a CRLF, which is not a block.
    if (lineEnd === lineStart && lineStart > 0) break;

    const valueStart = secretValueStart(text, lineStart, lineEnd, isSecretName, onKept);
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
  isSecretName: (name: string) => boolean,
  onKept?: (name: string, value: string) => void
): number | undefined {
  let index = start;
  while (index < end && isTokenCharacter(text.charCodeAt(index))) index += 1;
  if (index === start || text[index] !== ":") return undefined;
  const name = text.slice(start, index);
  const secret = isSecretName(name);

  index += 1;
  while (index < end && (text[index] === " " || text[index] === "\t")) index += 1;
  if (!secret) {
    onKept?.(name, text.slice(index, end));
    return undefined;
  }
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
