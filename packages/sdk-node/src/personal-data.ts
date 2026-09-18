import { printDiagnostic, type Diagnostic, type Diagnostics } from "./diagnostics.js";

/**
 * The warning for personal data in a value a reader sees in plain text: a
 * journey label, or an alias the caller marked displayable (F-006, F-012).
 *
 * ADR-055's pattern, applied to personal data rather than credentials: warn,
 * never redact on a guess, never alter the value. A label is text somebody
 * wrote to be read, and a displayable alias is an identifier somebody said was
 * public; changing either would make the journey list show something other
 * than what the host chose.
 *
 * The check is deliberately dumb. It matches an email shape and an
 * international phone shape and nothing else, because a cleverer rule that is
 * wrong prints at every deploy, and a default everybody silences is no
 * default. `ssn`, a customer number and a person's name are all personal data
 * this does not catch, which is why the documentation still states the rule.
 */

/** Where a value a reader sees in full came from. */
export type PublicValueField = "journeyLabel" | "displayableAliases";

/** What the value looked like. Part of the diagnostic, so these strings are stable. */
export type PersonalDataShape = "email" | "phone";

/**
 * Something shaped like an email address, anywhere in the value: a label is
 * usually a person or a company beside other text, not the address alone.
 * Linear, with no nested quantifier, so no input makes it expensive.
 */
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;

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
 * would be the default nobody keeps.
 */
const PHONE_SHAPE = /(?<![^\s([<])\+[\d\s().-]{7,20}/;
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
  if (EMAIL_SHAPE.test(text)) return "email";
  const phone = PHONE_SHAPE.exec(text);
  if (phone === null) return undefined;
  const digits = phone[0].match(DIGIT)?.length ?? 0;
  return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS ? "phone" : undefined;
}

const warned = new Set<PersonalDataShape>();
const printedShapes = new Set<PersonalDataShape>();

/** For tests: every shape warns again. */
export function forgetPersonalDataWarnings(): void {
  warned.clear();
  printedShapes.clear();
}

const ADVICE: Record<PersonalDataShape, string> = {
  email: "an email address",
  phone: "a telephone number"
};

/**
 * Warns if `value` looks like personal data, once per process and shape.
 *
 * Once per process and shape, not per value or per field: at most two lines
 * exist for the life of a process, which is enough to bring the rule to
 * somebody's attention and few enough that nobody silences it. The value is
 * never part of the report, and never changed.
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
    // The cheap gate first: once both shapes have warned, nothing is examined
    // again for the life of the process.
    if (warned.size === 2 || typeof value !== "string" || value === "") return;
    const shape = personalDataShapeOf(value);
    if (shape === undefined || warned.has(shape)) return;
    warned.add(shape);

    const where = field === "journeyLabel" ? "A journey label" : "An alias marked displayable";
    const diagnostic: Diagnostic = {
      kind: "personal_data_in_public_value",
      code: "personal_data_shape",
      reason:
        `${where} holds what looks like ${ADVICE[shape]}. It is stored, shown and searched ` +
        "in plain text and is never redacted, so a reader who may not be entitled to it sees " +
        "it in full. The value was not changed; if it is not personal data, nothing needs doing.",
      detail: { field, shape }
    };
    diagnostics.report(diagnostic, undefined, { unlimited: true });
    // Printed once per process and shape even with logging off, as ADR-055's
    // secret-name warning is: the value is stored in the clear, and nothing
    // else brings the rule to anybody's attention (SDK-40, SDK-63).
    if (printedShapes.has(shape) || logDiagnostics) return;
    printedShapes.add(shape);
    printDiagnostic(
      diagnostic,
      "printed once per process and value shape, whether or not logDiagnostics is on, because the value is stored in plain text"
    );
  } catch {
    // The label is set and the event is sent whatever happens here.
  }
}
