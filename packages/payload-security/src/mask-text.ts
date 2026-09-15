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
 * before storing. The text is reachable from public HTTP, so its cost has to
 * grow in proportion to its length: each pattern either anchors on a literal
 * prefix or refuses to start inside a run of its own characters, which keeps a
 * failed attempt from being retried at every position of the same run, and
 * whatever inspects a match afterwards is a character loop rather than another
 * regular expression. The tests time each adversarial shape at two sizes.
 */
export function maskSecretsInText(text: string): string {
  if (text === "") return text;

  // The order matters for idempotence as well as for reading. A rule must not
  // be able to create a match for a rule that ran before it, or the server's
  // second pass would mask what the SDK's first pass left. URL userinfo runs
  // early because every later rule removes characters, such as `/`, that ended
  // a userinfo span; its span refuses `[`, so a marker a later rule wrote can
  // never complete one.
  let result = text.replace(PEM_PRIVATE_KEY, REDACTED);
  result = result.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  result = result.replace(JSON_WEB_TOKEN, REDACTED);
  result = result.replace(PROVIDER_TOKEN, REDACTED);
  result = result.replace(
    WEBHOOK_URL_SECRET,
    (_match, slack: string | undefined, discord: string | undefined) =>
      `${slack ?? discord ?? ""}${REDACTED}`
  );
  result = maskAssignments(result);
  result = maskSchemeCredentials(result);
  return result;
}

/**
 * A whole private key block, PEM or PGP. An unterminated one, usually a message
 * cut off by a length limit, is masked to the end of the text rather than left
 * readable.
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g;

/** Header and claims both start `{"`, which base64url-encodes to `eyJ`. */
const JSON_WEB_TOKEN = /(?<![A-Za-z0-9_\]-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * Prefixes providers put on their credentials precisely so they can be found.
 *
 * Stripe secret and restricted keys and webhook secrets; Slack tokens; GitHub
 * classic, OAuth, user, server and refresh tokens and fine-grained tokens;
 * GitLab personal access tokens; AWS access key ids; Google API keys; OpenAI
 * and Anthropic keys; npm tokens; SendGrid keys; Slack app tokens; Hugging Face
 * tokens; and this product's own API keys, which are `fr_` and 32 base64url
 * characters.
 */
const PROVIDER_TOKEN = new RegExp(
  "(?<![A-Za-z0-9_\\]-])(?:" +
    [
      "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}",
      "whsec_[A-Za-z0-9+/=]{16,}",
      "xox[abprs]-[A-Za-z0-9-]{10,}",
      "gh[pousr]_[A-Za-z0-9]{20,}",
      "github_pat_[A-Za-z0-9_]{20,}",
      "glpat-[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+)*",
      "(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])",
      "AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])",
      "fr_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])",
      "sk-(?:proj-|ant-(?:api|admin)\\d\\d-)?[A-Za-z0-9_-]{20,}",
      "npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])",
      "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
      "xapp-[0-9A-Za-z-]{10,}",
      "hf_[A-Za-z0-9]{30,}"
    ].join("|") +
    ")",
  "g"
);

/**
 * The secret path segment of a Slack incoming webhook or a Discord webhook. The
 * rest of the URL stays, since it says which workspace and channel failed.
 */
const WEBHOOK_URL_SECRET =
  /(hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/)[A-Za-z0-9]+|(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/g;

/**
 * `scheme://userinfo@`. Greedy to the last `@` before the host ends, so a
 * password containing an unencoded `@` is masked whole rather than in part.
 * `,` and `;` end it too: they separate a URL from whatever follows it in a
 * list far more often than they appear unencoded in a password.
 */
const URL_USERINFO = /(?<![A-Za-z0-9+.\]-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"'<>,;[\]]+@/g;

/** `Bearer x`, `Basic x` and `Digest x` wherever they appear, not only after a header name. */
const AUTHORIZATION_SCHEME =
  /(?<![A-Za-z0-9_\]-])(Bearer|Basic|Digest)([ \t]+)([A-Za-z0-9._~+/-]+=*)/gi;

/** Shorter than this after a scheme word is a version or a product term, not a credential. */
const MIN_SCHEME_CREDENTIAL_LENGTH = 8;

/**
 * Every scheme credential, masked.
 *
 * A loop rather than `String.replace`, for the same reason as
 * {@link maskAssignments}: a match that turns out not to be a credential must
 * not consume the text after its scheme word. In `Bearer Bearer abc123def456`
 * the first match is `Bearer Bearer`, too short to mask; consuming it hid the
 * real credential from the first pass and showed it to the second.
 */
function maskSchemeCredentials(text: string): string {
  let output = "";
  let copied = 0;
  AUTHORIZATION_SCHEME.lastIndex = 0;

  for (let match = AUTHORIZATION_SCHEME.exec(text); match !== null;) {
    const [whole, scheme = "", space = "", raw = ""] = match;
    const end = match.index + whole.length;
    const credential = withoutTrailingDots(raw);

    if (isSchemeCredential(raw, credential, text[end])) {
      output += text.slice(copied, match.index) + scheme + space + REDACTED;
      copied = match.index + scheme.length + space.length + credential.length;
      AUTHORIZATION_SCHEME.lastIndex = copied;
    } else {
      AUTHORIZATION_SCHEME.lastIndex = match.index + scheme.length;
    }
    match = AUTHORIZATION_SCHEME.exec(text);
  }

  return copied === 0 ? text : output + text.slice(copied);
}

function isSchemeCredential(raw: string, credential: string, after: string | undefined): boolean {
  // `Bearer realm="api"` is a WWW-Authenticate challenge: its auth-params name
  // things, and none of them is the credential.
  if (raw.endsWith("=") && (after === '"' || after === "'")) return false;
  if (isAuthParam(raw)) return false;
  return credential.length >= MIN_SCHEME_CREDENTIAL_LENGTH && !readsAsProse(credential);
}

/** `realm=`: letters and a single `=`, which is a parameter name, not base64. */
function isAuthParam(raw: string): boolean {
  if (raw.length < 2 || !raw.endsWith("=")) return false;
  for (let index = 0; index < raw.length - 1; index += 1) {
    if (!isLetter(raw.charCodeAt(index))) return false;
  }
  return true;
}

/**
 * A name followed by `=` or `:`, optionally quoted, including the escaped quotes
 * of JSON serialised inside a JSON string. The value is read by hand after the
 * match so that a name which turns out not to be a secret consumes nothing
 * beyond its separator, and the next name is still seen.
 *
 * `.` belongs to the name, so `spring.datasource.password` is one name whose
 * last word is `password`.
 */
const NAME_AND_SEPARATOR =
  /(?<![A-Za-z0-9_.\]-])(\\?["']|)([A-Za-z][A-Za-z0-9_.-]*)\1[ \t]*([=:])([ \t]*)/g;

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
 * Single words that are a secret when assigned, as `name=value` or as a quoted
 * key, but that are too common in prose to trust after an unquoted colon:
 * `Invalid token: expired` is a sentence, not a credential.
 */
const ASSIGNED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "token",
  "signature",
  "sig",
  "passwd",
  "pwd",
  "pass"
]);

/**
 * The last word of a name made of several words that marks it a secret:
 * `DB_PASSWORD`, `JWT_SECRET`, `GITHUB_TOKEN`.
 */
const SECRET_LAST_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "credentials"
]);

/** Tokens that page, resume or protect a form rather than authenticate anyone. */
const NON_SECRET_TOKEN_QUALIFIERS: ReadonlySet<string> = new Set([
  "page",
  "next",
  "continuation",
  "pagination",
  "cursor",
  "sync",
  "resume",
  "marker",
  "csrf",
  "xsrf"
]);

/** The last two words of a name that make it a secret: `STRIPE_API_KEY`, `privateKey`. */
const SECRET_LAST_PAIRS: ReadonlySet<string> = new Set([
  "api key",
  "secret key",
  "private key",
  "access key",
  "account key",
  "signing key",
  "master key",
  "shared key",
  "encryption key",
  "auth key",
  "session key",
  "client key"
]);

/** A name ending in one of these points at a secret rather than holding one: `SecretId`. */
const REFERENCE_LAST_WORDS: ReadonlySet<string> = new Set(["id", "arn", "name", "url"]);

/** Headers whose value may hold a scheme word before the credential. */
const SCHEME_NAMES: ReadonlySet<string> = new Set(["authorization", "proxyauthorization"]);

/** Headers whose unquoted value is the rest of the line, since cookies are `;`-separated. */
const LINE_NAMES: ReadonlySet<string> = new Set(["cookie", "setcookie"]);

function maskAssignments(text: string): string {
  let output = "";
  let copied = 0;
  NAME_AND_SEPARATOR.lastIndex = 0;

  for (let match = NAME_AND_SEPARATOR.exec(text); match !== null;) {
    const [whole, quote = "", rawName = "", separator = "", blankAfter = ""] = match;
    const valueStart = match.index + whole.length;
    const kind = classifyName(text, match.index, quote, rawName, separator, blankAfter !== "");

    const replacement =
      kind === undefined ? undefined : maskedValue(text, valueStart, kind.name, kind.prose);

    if (replacement !== undefined) {
      output += text.slice(copied, valueStart) + replacement.text;
      copied = replacement.end;
      NAME_AND_SEPARATOR.lastIndex = replacement.end;
    }
    match = NAME_AND_SEPARATOR.exec(text);
  }

  return copied === 0 ? text : output + text.slice(copied);
}

interface SecretName {
  /** The name's words joined, as the built-in list is compared. */
  name: string;
  /** Whether a plain word in the value reads as a sentence and is left alone. */
  prose: boolean;
}

/**
 * Whether the name before a separator holds a secret, and how to read its value.
 *
 * - An unquoted `name:` needs a blank after the colon, so `secret:prod/db`
 *   inside an ARN is a path and not an assignment.
 * - A built-in name is a secret in every form.
 * - Any other single word counts only from its own short list, and only when
 *   assigned; `key` only as a query parameter.
 * - A name of several words counts by its last word or last two
 *   ({@link isSecretPhrase}), in every form, with its unquoted value read for
 *   prose: `DB_PASSWORD: not set` is a sentence.
 */
function classifyName(
  text: string,
  index: number,
  quote: string,
  rawName: string,
  separator: string,
  blankAfter: boolean
): SecretName | undefined {
  const unquotedColon = quote === "" && separator === ":";
  if (unquotedColon && !blankAfter) return undefined;

  const words = nameWords(rawName);
  const name = words.join("");
  if (SECRET_NAMES.has(name)) return { name, prose: unquotedColon };

  if (words.length === 1) {
    if (unquotedColon) return undefined;
    if (ASSIGNED_SECRET_NAMES.has(name)) return { name, prose: false };
    // `key` alone is far too common a word, so only a query parameter counts.
    const previous = text[index - 1];
    if (name === "key" && quote === "" && (previous === "?" || previous === "&")) {
      return { name, prose: false };
    }
    return undefined;
  }

  return isSecretPhrase(words) ? { name, prose: quote === "" } : undefined;
}

function isSecretPhrase(words: readonly string[]): boolean {
  const last = words[words.length - 1] ?? "";
  const before = words[words.length - 2] ?? "";
  if (REFERENCE_LAST_WORDS.has(last)) return false;
  if (SECRET_LAST_WORDS.has(last)) {
    return !(last === "token" && NON_SECRET_TOKEN_QUALIFIERS.has(before));
  }
  return SECRET_LAST_PAIRS.has(`${before} ${last}`);
}

/**
 * A name's words, lowercased: split on `_`, `-` and `.`, and where the case
 * changes, as `([a-z0-9])([A-Z])` and `([A-Z]+)([A-Z][a-z])` would split it.
 * `X-Amz-Security-Token`, `APIKey` and `nextPageToken` become
 * `x amz security token`, `api key` and `next page token`.
 *
 * A loop rather than those two replacements: the second backtracks over a run
 * of capitals from every capital in it.
 */
function nameWords(rawName: string): string[] {
  const words: string[] = [];
  let start = 0;
  const push = (end: number): void => {
    if (end > start) words.push(rawName.slice(start, end).toLowerCase());
  };

  for (let index = 0; index < rawName.length; index += 1) {
    const code = rawName.charCodeAt(index);
    if (code === UNDERSCORE || code === HYPHEN || code === FULL_STOP) {
      push(index);
      start = index + 1;
      continue;
    }
    if (index === start || !isUpper(code)) continue;
    const previous = rawName.charCodeAt(index - 1);
    const next = rawName.charCodeAt(index + 1);
    if (isLower(previous) || isDigit(previous) || (isUpper(previous) && isLower(next))) {
      push(index);
      start = index;
    }
  }
  push(rawName.length);
  return words;
}

interface Replacement {
  text: string;
  end: number;
}

/**
 * The masked form of the value at `start`, or undefined to leave it alone.
 *
 * `prose` marks a form where a plain word after the separator is far more
 * likely a sentence than a credential: `client_secret: missing`.
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
    if (content === "") return undefined;
    // `cookie: session expired; please sign in` is a sentence about a cookie.
    if (prose && (isPlainWord(content) || startsWithWordAndBlank(content))) return undefined;
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
 * The value with any trailing full stops removed, so `Bearer token.` ends a
 * sentence rather than presenting a credential.
 *
 * A loop, not `/\.+$/`. That regex is tried from every dot in a run and scans to
 * the end of the run from each, so `Bearer ` and 64 KiB of dots took almost two
 * seconds to mask.
 */
function withoutTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === FULL_STOP) end -= 1;
  return value.slice(0, end);
}

/**
 * A lowercase word, a capitalised one, or one in capitals: `missing`, `Token`,
 * `NONE`. A random credential of any useful length is essentially never one of
 * these, and the words that follow a secret's name in an error message nearly
 * always are.
 */
function isPlainWord(value: string): boolean {
  if (value === "") return false;
  const first = value.charCodeAt(0);
  if (!isLetter(first)) return false;
  let lower = true;
  let upper = isUpper(first);
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    lower &&= isLower(code);
    upper &&= isUpper(code);
    if (!lower && !upper) return false;
  }
  return true;
}

/**
 * Words and numbers joined by hyphens, `plan-2026` or `Token`, which is how
 * prose reads after a scheme word and how no issued credential looks.
 */
function readsAsProse(value: string): boolean {
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value.charCodeAt(index) !== HYPHEN) continue;
    const piece = value.slice(start, index);
    if (!isPlainWord(piece) && !isNumber(piece)) return false;
    start = index + 1;
  }
  return true;
}

/** `session expired`: a word of letters followed by a blank. */
function startsWithWordAndBlank(value: string): boolean {
  let index = 0;
  while (index < value.length && isLetter(value.charCodeAt(index))) index += 1;
  const next = value[index];
  return index > 0 && (next === " " || next === "\t");
}

function isNumber(value: string): boolean {
  if (value === "") return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isDigit(value.charCodeAt(index))) return false;
  }
  return true;
}

const FULL_STOP = 0x2e;
const HYPHEN = 0x2d;
const UNDERSCORE = 0x5f;

function isUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isLetter(code: number): boolean {
  return isUpper(code) || isLower(code);
}
