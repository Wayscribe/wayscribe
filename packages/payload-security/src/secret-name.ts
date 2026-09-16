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
interface Term {
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
const TERMS: readonly Term[] = [
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
 * for the version suffix, and a constant number of `endsWith` checks against
 * short terms.
 *
 * This is a warning heuristic only. It never decides what is redacted
 * (ADR-055): a diff must not change on a guess.
 */
export function looksLikeSecretName(name: string): boolean {
  const folded = withoutVersion(normaliseName(name));
  if (folded === "") return false;
  return TERMS.some((entry) => matchesTerm(folded, entry));
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
