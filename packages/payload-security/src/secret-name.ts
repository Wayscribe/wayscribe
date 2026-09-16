import { normaliseName } from "./normalise-name.js";

/**
 * A term a secret name ends with.
 *
 * `except` lists words that make the term harmless when they come directly
 * before it (`nextPageToken`). `qualifiers`, when present, are the only words
 * the term may follow, and `alone` says whether it matches on its own: a short
 * term such as `pin` ends too many ordinary words (`spin`, `hairpin`) to be
 * matched as a plain suffix.
 */
export interface Term {
  term: string;
  except?: readonly string[];
  qualifiers?: readonly string[];
  alone?: boolean;
}

/**
 * The fixed table the heuristic reads. Documented, with its reasons, in
 * docs/superpowers/specs/2026-09-16-secret-name-warning-design.md section 1.
 *
 * Deliberately absent: bare `key` (`monkey`, `publicKey`, `partitionKey`),
 * bare `session` (a Stripe Checkout session id), bare `code`, plurals such as
 * `tokens` (usage counts), and personal data, which is a different question.
 */
export const SECRET_NAME_TERMS: readonly Term[] = [
  {
    term: "token",
    // Pagination, sync and idempotency tokens are cursors, not credentials.
    except: ["page", "next", "continuation", "pagination", "sync", "client", "idempotency"]
  },
  { term: "secret" },
  { term: "password" },
  { term: "passwd" },
  { term: "passphrase" },
  { term: "passcode" },
  // `PWD` is the working directory in every environment dump.
  { term: "pwd", qualifiers: ["db", "user", "admin", "root", "database"], alone: false },
  { term: "credential" },
  { term: "credentials" },
  { term: "authorization" },
  { term: "auth" },
  { term: "bearer" },
  { term: "cookie" },
  { term: "cookies" },
  { term: "signature", except: ["email"] },
  { term: "jwt" },
  { term: "otp" },
  { term: "cvv" },
  { term: "cvc" },
  {
    term: "pin",
    qualifiers: ["card", "atm", "user", "account", "security", "login", "new", "old", "current"],
    alone: true
  },
  { term: "apikey" },
  { term: "accesskey" },
  { term: "secretkey" },
  { term: "privatekey" },
  { term: "signingkey" },
  { term: "encryptionkey" },
  { term: "masterkey" },
  { term: "sessionkey" },
  { term: "authkey" },
  { term: "hmackey" },
  { term: "sharedkey" },
  { term: "sessionid" },
  { term: "sessid" },
  { term: "secretstring" },
  { term: "secretvalue" },
  { term: "codeverifier" },
  { term: "clientassertion" },
  { term: "authcode" },
  { term: "authorizationcode" },
  { term: "otpcode" },
  { term: "mfacode" }
];

/**
 * Whether a key name reads like one that holds a credential.
 *
 * The name is folded as redaction folds it, a version suffix is dropped, and
 * its end is compared with a fixed table of terms. A secret name nearly always
 * ends with the noun that makes it secret (`stripeWebhookSecret`), and a name
 * that only starts with one nearly never is (`tokenCount`, `secretName`), so
 * matching the end is what keeps this precise.
 *
 * Deterministic, and linear in the name's length: one fold, one backward scan
 * for the version suffix, one map lookup on the last three characters, and at
 * most a few `endsWith` checks against short terms.
 *
 * This is a warning heuristic only. It never decides what is redacted
 * (ADR-055): a diff must not change on a guess.
 */
export function looksLikeSecretName(name: string): boolean {
  return looksLikeSecretFoldedName(normaliseName(name));
}

/** {@link looksLikeSecretName} for a name already passed through `normaliseName`. */
export function looksLikeSecretFoldedName(folded: string): boolean {
  const name = withoutVersion(folded);
  if (name.length < 3) return false;
  const candidates = TERMS_BY_TAIL.get(tailOf(name));
  return candidates !== undefined && candidates.some((entry) => matchesTerm(name, entry));
}

/**
 * The terms by their last three characters, three being the length of the
 * shortest term.
 *
 * The walk asks about every key holding a string or a number, which in an
 * ordinary payload is most of them, and almost none is a secret. Comparing
 * each with every term cost about half again the time capture takes; one map
 * lookup rules nearly all of them out and leaves at most a few terms to
 * compare. The three characters are packed into one number rather than
 * sliced, so the lookup allocates nothing.
 */
const TERMS_BY_TAIL = new Map<number, Term[]>();
for (const entry of SECRET_NAME_TERMS) {
  const tail = tailOf(entry.term);
  TERMS_BY_TAIL.set(tail, [...(TERMS_BY_TAIL.get(tail) ?? []), entry]);
}

/** The last three UTF-16 code units of a name of at least three, as one number. */
function tailOf(name: string): number {
  const end = name.length;
  return (
    name.charCodeAt(end - 3) * 0x1_0000_0000 +
    name.charCodeAt(end - 2) * 0x1_0000 +
    name.charCodeAt(end - 1)
  );
}

function matchesTerm(name: string, { term, except, qualifiers, alone }: Term): boolean {
  if (!name.endsWith(term)) return false;
  if (name.length === term.length) return alone ?? true;
  if (qualifiers !== undefined) {
    return qualifiers.some((qualifier) => name.endsWith(qualifier + term));
  }
  return except === undefined || !except.some((word) => name.endsWith(word + term));
}

/**
 * The name without trailing digits and a `v` directly before them, so
 * `signature256` and `signaturev3` end in `signature`.
 *
 * A backward scan rather than `/v?\d+$/`: a pattern anchored only at the end
 * is retried from every position, which is quadratic on a long run of digits
 * followed by anything else.
 */
function withoutVersion(name: string): string {
  let end = name.length;
  while (end > 0 && isDigit(name.charCodeAt(end - 1))) end -= 1;
  if (end === name.length) return name;
  if (end > 0 && name[end - 1] === "v") end -= 1;
  return name.slice(0, end);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
