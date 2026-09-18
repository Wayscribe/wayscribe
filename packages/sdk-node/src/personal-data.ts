import { printDiagnostic, type Diagnostic, type Diagnostics } from "./diagnostics.js";

/**
 * The warning for personal data in a value a reader sees in plain text: a
 * journey label, an alias the caller marked displayable, or an error's message
 * (F-006, F-012, F-041, ADR-062).
 *
 * ADR-055's pattern, applied to personal data rather than credentials: warn,
 * never redact on a guess, never alter the value. A label is text somebody
 * wrote to be read, a displayable alias is an identifier somebody said was
 * public, and an error message is what a reader needs to understand a
 * failure; changing any of them would make the timeline show something other
 * than what the host chose.
 *
 * The check is deliberately dumb. It matches an email shape and an
 * international phone shape and nothing else, because a cleverer rule that is
 * wrong prints at every deploy, and a default everybody silences is no
 * default. `ssn`, a customer number and a person's name are all personal data
 * this does not catch, which is why the documentation still states the rule.
 */

/** Where a value a reader sees in full came from. */
export type PublicValueField = "journeyLabel" | "displayableAliases" | "errorMessage";

/** What the value looked like. Part of the diagnostic, so these strings are stable. */
export type PersonalDataShape = "email" | "phone";

/**
 * Something shaped like the start of an email address, anywhere in the value:
 * a label is usually a person or a company beside other text, not the address
 * alone. `emailIn` decides whether what follows the `@` is a domain.
 *
 * The local part starts the value or follows whitespace, a bracket, a quote,
 * `,`, `;`, `=` or `:`, and holds none of those, nor `/`, `[` or `]`. That is
 * what keeps paths and URLs out: `node_modules/@aws-sdk/...`,
 * `lodash@4.17.21/fp.js`, `@scope/pkg@1.2.3`, `registry/app@sha256:...` and
 * `postgres://[REDACTED]@db.internal`, the SDK's own masked userinfo, all have
 * a `/`, `[` or `]` where a local part would be (F-041 review).
 *
 * Linear: a match starts only after a delimiter, and a run between two
 * delimiters is scanned once, so no input makes it expensive.
 */
const EMAIL_CANDIDATE = /(?<![^\s<>()"',;=:])[^\s<>()"',;=:@/[\]]+@([A-Za-z0-9.-]+)/g;
const TOP_LEVEL_DOMAIN = /^[A-Za-z]{2,}$/;

/**
 * Whether the text holds an email address: a candidate whose domain has at
 * least two labels, none empty, ending in letters, and is not followed by `:`,
 * `/` or `@`. A host followed by one of those is a git remote
 * (`git@github.com:org/repo.git`), an ssh target (`deploy@build.example.com:
 * Permission denied`) or a path, not an address.
 */
function emailIn(text: string): boolean {
  EMAIL_CANDIDATE.lastIndex = 0;
  for (let match = EMAIL_CANDIDATE.exec(text); match !== null;) {
    const after = text.charAt(match.index + match[0].length);
    const domain = (match[1] ?? "").replace(/\.+$/, "");
    const labels = domain.split(".");
    if (
      after !== ":" &&
      after !== "/" &&
      after !== "@" &&
      labels.length >= 2 &&
      !labels.includes("") &&
      TOP_LEVEL_DOMAIN.test(labels.at(-1) ?? "")
    ) {
      return true;
    }
    match = EMAIL_CANDIDATE.exec(text);
  }
  return false;
}

/**
 * Something shaped like an international telephone number: a `+` that starts
 * the value or follows whitespace or an opening bracket, then at least eight
 * and at most fifteen digits (E.164's own bound), with the spaces, dashes,
 * dots and parentheses people write between them.
 *
 * Where the `+` sits is what keeps version and digest text out of it: a `+`
 * after other characters is not a dialling code, as `1.2.3+20130313144700` and
 * a base64 digest show. The digit count keeps `+3 more` and
 * `2026-09-17T12:00:00+01:00` out too.
 *
 * A national number written without the `+` is not matched: `555 010 9999` and
 * an order number are the same shape, and warning about every order number
 * would be the default nobody keeps. Nor is a `+` followed by exactly four
 * digits, which is a timezone offset: `Fri Sep 18 14:00:00 +0000 2026` has
 * eight digits from `+` to the year (F-041 review).
 */
const PHONE_SHAPE = /(?<![^\s([<])\+[\d\s().-]{7,20}/g;
const TIMEZONE_OFFSET = /^\+\d{4}(?!\d)/;
const DIGIT = /\d/g;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

/**
 * How much of a value is examined. A label is at most 200 code points by the
 * time it is checked, but an alias value may be 512, and a host may pass more
 * before the caps are applied; the shapes are all near the start of anything
 * that has one.
 */
const MAX_EXAMINED = 1_024;

/** The shape the value looks like, or undefined. Never throws. */
export function personalDataShapeOf(value: string): PersonalDataShape | undefined {
  const text = value.length <= MAX_EXAMINED ? value : value.slice(0, MAX_EXAMINED);
  if (emailIn(text)) return "email";
  PHONE_SHAPE.lastIndex = 0;
  for (let phone = PHONE_SHAPE.exec(text); phone !== null; phone = PHONE_SHAPE.exec(text)) {
    if (TIMEZONE_OFFSET.test(phone[0])) continue;
    const digits = phone[0].match(DIGIT)?.length ?? 0;
    if (digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS) return "phone";
  }
  return undefined;
}

/** A field and a shape: the unit the warning is given once for. */
type WarningKey = `${PublicValueField}:${PersonalDataShape}`;

const warned = new Set<WarningKey>();
const printedShapes = new Set<WarningKey>();

/** For tests: every field and shape warns again. */
export function forgetPersonalDataWarnings(): void {
  warned.clear();
  printedShapes.clear();
}

const ADVICE: Record<PersonalDataShape, string> = {
  email: "an email address",
  phone: "a telephone number"
};

/**
 * What the reason says about each field: where the value came from, and how a
 * reader comes to see it. An error message is not searched, unlike the other
 * two, and is masked for credential shapes, which leaves personal data alone.
 */
const WHERE: Record<PublicValueField, { subject: string; exposure: string }> = {
  journeyLabel: {
    subject: "A journey label",
    exposure: "It is stored, shown and searched in plain text and is never redacted"
  },
  displayableAliases: {
    subject: "An alias marked displayable",
    exposure: "It is stored, shown and searched in plain text and is never redacted"
  },
  errorMessage: {
    subject: "An error message",
    exposure:
      "It is stored and shown in plain text wherever the timeline is, and masking covers credential shapes, not personal data"
  }
};

/**
 * Warns if `value` looks like personal data, once per process, field and
 * shape.
 *
 * Once per field and shape, not per value: at most six lines exist for the
 * life of a process, three fields by two shapes, which is enough to bring the
 * rule to somebody's attention and few enough that nobody silences it. Per
 * field and not per shape alone, because the fields are not equally noisy: an
 * error message holds far more text nobody chose than a label does, and one
 * warning spent on an error message must not silence a label or an alias that
 * holds an address later (F-041 review, ADR-062). The value is never part of
 * the report, and never changed.
 *
 * Never throws: this runs inside recording a step, and a warning must not cost
 * the event it is about.
 */
export function warnAboutPersonalData(
  value: unknown,
  field: PublicValueField,
  diagnostics: Diagnostics,
  logDiagnostics: boolean
): void {
  try {
    // The cheap gate first: once both shapes have warned for this field,
    // nothing of it is examined again for the life of the process.
    if (warned.has(`${field}:email`) && warned.has(`${field}:phone`)) return;
    if (typeof value !== "string" || value === "") return;
    const shape = personalDataShapeOf(value);
    if (shape === undefined) return;
    const key: WarningKey = `${field}:${shape}`;
    if (warned.has(key)) return;
    warned.add(key);

    const where = WHERE[field];
    const diagnostic: Diagnostic = {
      kind: "personal_data_in_public_value",
      code: "personal_data_shape",
      reason:
        `${where.subject} holds what looks like ${ADVICE[shape]}. ${where.exposure}, ` +
        "so a reader who may not be entitled to it sees it in full. The value was not " +
        "changed; if it is not personal data, nothing needs doing.",
      detail: { field, shape }
    };
    diagnostics.report(diagnostic, undefined, { unlimited: true });
    // Printed once per process, field and shape even with logging off, as
    // ADR-055's secret-name warning is: the value is stored in the clear, and
    // nothing else brings the rule to anybody's attention (SDK-40, SDK-63).
    if (printedShapes.has(key) || logDiagnostics) return;
    printedShapes.add(key);
    printDiagnostic(
      diagnostic,
      "printed once per process, field and value shape, whether or not logDiagnostics is on, because the value is stored in plain text"
    );
  } catch {
    // The label is set, and the event is sent, whatever happens here.
  }
}
