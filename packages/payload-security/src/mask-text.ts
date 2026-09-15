import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { normaliseName, REDACTED } from "./redact.js";

/**
 * Replace credential-shaped substrings in free text with `[REDACTED]`.
 *
 * Path redaction matches the name a value is filed under, so it cannot reach a
 * credential pasted inside a string, and error text is exactly where those end
 * up: a connection string in `ECONNREFUSED`, a header echoed by an HTTP client,
 * a key quoted back by the provider that refused it. This recognises the shapes
 * those take and nothing else (ADR-045).
 *
 * It deliberately does not guess at entropy. The identifiers this product
 * exists to show, Salesforce ids, UUIDs, order numbers and hashes, are long and
 * random-looking, and masking them would destroy the record a reader came for.
 * A token in a shape not listed here is missed, and the documentation says so.
 *
 * Idempotent, because the SDK masks before sending and the server masks again
 * before storing. Every pattern runs in linear time: the text is reachable from
 * public HTTP, so each one either anchors on a literal prefix or refuses to
 * start inside a run of its own characters, which keeps a failed attempt from
 * being retried at every position of the same run.
 */
export function maskSecretsInText(text: string): string {
  if (text === "") return text;

  let result = text.replace(PEM_PRIVATE_KEY, REDACTED);
  result = result.replace(JSON_WEB_TOKEN, REDACTED);
  result = result.replace(PROVIDER_TOKEN, REDACTED);
  result = result.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  result = maskAssignments(result);
  result = result.replace(
    AUTHORIZATION_SCHEME,
    (match, scheme: string, space: string, raw: string) => {
      const credential = raw.replace(/\.+$/, "");
      if (isPlainWord(credential)) return match;
      return `${scheme}${space}${REDACTED}${raw.slice(credential.length)}`;
    }
  );
  return result;
}

/**
 * A whole private key block. An unterminated one, usually a message cut off by
 * a length limit, is masked to the end of the text rather than left readable.
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g;

/** Header and claims both start `{"`, which base64url-encodes to `eyJ`. */
const JSON_WEB_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * Prefixes providers put on their credentials precisely so they can be found.
 *
 * Stripe secret and restricted keys and webhook secrets; Slack tokens; GitHub
 * classic, OAuth, user, server and refresh tokens and fine-grained tokens;
 * GitLab personal access tokens; AWS access key ids; Google API keys; and this
 * product's own API keys, which are `fr_` and 32 base64url characters.
 */
const PROVIDER_TOKEN = new RegExp(
  "(?<![A-Za-z0-9_-])(?:" +
    [
      "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}",
      "whsec_[A-Za-z0-9+/=]{16,}",
      "xox[abprs]-[A-Za-z0-9-]{10,}",
      "gh[pousr]_[A-Za-z0-9]{20,}",
      "github_pat_[A-Za-z0-9_]{20,}",
      "glpat-[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+)*",
      "(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])",
      "AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])",
      "fr_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])"
    ].join("|") +
    ")",
  "g"
);

/**
 * `scheme://userinfo@`. Greedy to the last `@` before the host ends, so a
 * password containing an unencoded `@` is masked whole rather than in part.
 */
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"'<>]+@/g;

/** `Bearer x` and `Basic x` wherever they appear, not only after a header name. */
const AUTHORIZATION_SCHEME = /(?<![A-Za-z0-9_-])(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/-]+=*)/gi;

/**
 * A name followed by `=` or `:`, optionally quoted, including the escaped quotes
 * of JSON serialised inside a JSON string. The value is read by hand after the
 * match so that a name which turns out not to be a secret consumes nothing
 * beyond its separator, and the next name is still seen.
 */
const NAME_AND_SEPARATOR =
  /(?<![A-Za-z0-9_-])(\\?["']|)([A-Za-z][A-Za-z0-9_-]*)\1[ \t]*([=:])[ \t]*/g;

/**
 * The built-in secret names, compared as path redaction compares them (ADR-039).
 * These are names that mean a secret in any form, including `name: value`.
 */
const SECRET_NAMES: ReadonlySet<string> = new Set(
  DEFAULT_SECRET_PATHS.flatMap((path) =>
    path.startsWith("**.") ? [normaliseName(path.slice(3))] : []
  )
);

/**
 * Names that are a secret when assigned, as `name=value` or as a quoted key,
 * but that are too common in prose to trust after an unquoted colon:
 * `Invalid token: expired` is a sentence, not a credential.
 */
const ASSIGNED_SECRET_NAMES: ReadonlySet<string> = new Set(["token", "signature", "sig", "apikey"]);

/** Headers whose value may hold a scheme word before the credential. */
const SCHEME_NAMES: ReadonlySet<string> = new Set(["authorization", "proxyauthorization"]);

/** Headers whose unquoted value is the rest of the line, since cookies are `;`-separated. */
const LINE_NAMES: ReadonlySet<string> = new Set(["cookie", "setcookie"]);

function maskAssignments(text: string): string {
  let output = "";
  let copied = 0;
  NAME_AND_SEPARATOR.lastIndex = 0;

  for (let match = NAME_AND_SEPARATOR.exec(text); match !== null;) {
    const [whole, quote = "", rawName = "", separator = ""] = match;
    const valueStart = match.index + whole.length;
    const name = normaliseName(rawName);

    const replacement = secretName(text, match.index, quote, name, separator)
      ? maskedValue(text, valueStart, name, quote === "" && separator === ":")
      : undefined;

    if (replacement !== undefined) {
      output += text.slice(copied, valueStart) + replacement.text;
      copied = replacement.end;
      NAME_AND_SEPARATOR.lastIndex = replacement.end;
    }
    match = NAME_AND_SEPARATOR.exec(text);
  }

  return copied === 0 ? text : output + text.slice(copied);
}

function secretName(
  text: string,
  index: number,
  quote: string,
  name: string,
  separator: string
): boolean {
  if (SECRET_NAMES.has(name)) return true;
  // An unquoted `name:` is only trusted for the built-in names.
  const assigned = quote !== "" || separator === "=";
  if (assigned && ASSIGNED_SECRET_NAMES.has(name)) return true;
  // `key` alone is far too common a word, so only a query parameter counts.
  const previous = text[index - 1];
  return (
    name === "key" && quote === "" && separator === "=" && (previous === "?" || previous === "&")
  );
}

interface Replacement {
  text: string;
  end: number;
}

/**
 * The masked form of the value at `start`, or undefined to leave it alone.
 *
 * `prose` is an unquoted `name: value`, where a plain word after the colon is
 * far more likely a sentence than a credential: `client_secret: missing`.
 */
function maskedValue(
  text: string,
  start: number,
  name: string,
  prose: boolean
): Replacement | undefined {
  const escapedQuote = text.startsWith('\\"', start) || text.startsWith("\\'", start);
  const first = text[start];
  if (escapedQuote || first === '"' || first === "'") {
    const delimiter = escapedQuote ? text.slice(start, start + 2) : (first ?? "");
    const contentStart = start + delimiter.length;
    const contentEnd = closingQuote(text, contentStart, delimiter);
    const content = text.slice(contentStart, contentEnd);
    const masked = maskContent(content, name);
    if (masked === undefined) return undefined;
    return { text: delimiter + masked, end: contentEnd };
  }

  if (text.startsWith(REDACTED, start)) return undefined;

  if (LINE_NAMES.has(name)) {
    const end = lineEnd(text, start);
    const content = text.slice(start, end);
    if (content === "" || (prose && isPlainWord(content))) return undefined;
    return { text: REDACTED, end };
  }

  if (SCHEME_NAMES.has(name)) {
    const schemed = schemeAndCredential(text, start);
    if (schemed !== undefined) {
      if (text.startsWith(REDACTED, schemed.credentialStart)) return undefined;
      const credential = text.slice(schemed.credentialStart, schemed.end);
      if (prose && isPlainWord(credential)) return undefined;
      return { text: text.slice(start, schemed.credentialStart) + REDACTED, end: schemed.end };
    }
  }

  const end = tokenEnd(text, start);
  const token = text.slice(start, end);
  if (token === "" || EMPTY_LITERALS.has(token) || (prose && isPlainWord(token))) {
    return undefined;
  }
  return { text: REDACTED, end };
}

/**
 * Unquoted values that say a secret is absent. `"password": null` is often the
 * whole explanation of the error, and it holds nothing to protect.
 */
const EMPTY_LITERALS: ReadonlySet<string> = new Set(["null", "undefined", "true", "false"]);

/** Quoted content, masked after any scheme word; undefined if already masked. */
function maskContent(content: string, name: string): string | undefined {
  if (content === "" || content === REDACTED) return undefined;
  if (SCHEME_NAMES.has(name)) {
    const scheme = /^[A-Za-z][A-Za-z0-9-]*[ \t]+/.exec(content);
    if (scheme !== null && scheme[0].length < content.length) {
      const rest = content.slice(scheme[0].length);
      return rest === REDACTED ? undefined : scheme[0] + REDACTED;
    }
  }
  return REDACTED;
}

/**
 * End of a quoted value: its closing quote, or the end of the line if it has
 * none. Scanned by hand so the cost is the value's own length, never the rest
 * of the text.
 */
function closingQuote(text: string, from: number, delimiter: string): number {
  let index = from;
  while (index < text.length && !isLineBreak(text[index])) {
    if (text.startsWith(delimiter, index)) return index;
    index += delimiter.length === 1 && text[index] === "\\" ? 2 : 1;
  }
  return Math.min(index, text.length);
}

function lineEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && !isLineBreak(text[index])) index += 1;
  return index;
}

function isLineBreak(character: string | undefined): boolean {
  return character === "\n" || character === "\r";
}

/**
 * An unquoted value ends at whitespace, a quote, a query separator, or
 * punctuation that encloses or lists rather than belongs to a token. `[` ends
 * it too, which is what makes an already-masked value read as empty.
 */
const TOKEN_STOP = /[\s"'&,;<>()[\]{}\\]/;

function tokenEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && !TOKEN_STOP.test(text[index] ?? "")) index += 1;
  return index;
}

/** `Bearer x`: a scheme word, blanks, and a non-empty credential token. */
function schemeAndCredential(
  text: string,
  start: number
): { credentialStart: number; end: number } | undefined {
  const scheme = /[A-Za-z][A-Za-z0-9-]*[ \t]+/y;
  scheme.lastIndex = start;
  if (scheme.exec(text) === null) return undefined;
  const credentialStart = scheme.lastIndex;
  if (text.startsWith(REDACTED, credentialStart)) return { credentialStart, end: credentialStart };
  const end = tokenEnd(text, credentialStart);
  return end === credentialStart ? undefined : { credentialStart, end };
}

/**
 * A lowercase word, a capitalised one, or one in capitals: `missing`, `Token`,
 * `NONE`. A random credential of any useful length is essentially never one of
 * these, and the words that follow a secret's name in an error message nearly
 * always are.
 */
function isPlainWord(value: string): boolean {
  return /^(?:[A-Za-z][a-z]*|[A-Z]+)$/.test(value);
}
