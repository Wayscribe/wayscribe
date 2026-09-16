import {
  normaliseName,
  type UnredactedObserver
} from "@flight-recorder/payload-security/redaction";
import { printDiagnostic, type Diagnostic, type Diagnostics } from "./diagnostics.js";

/**
 * The warning for a value kept under a name that reads as a secret (ADR-055).
 *
 * The redaction walk finds these; this decides which to report and how. A
 * warning, never a redaction: replacing values on a guess would change what the
 * timeline shows, and a diff that hides a real change is the failure this
 * product exists to prevent.
 */

export type PayloadField = "input" | "output" | "metadata";

/**
 * How many distinct names are remembered, per recorder and per process. A
 * payload keyed by generated names (`vendor123Token`) must not grow the host's
 * memory, and a hundred warnings is already more than anyone reads.
 */
export const MAX_REMEMBERED_NAMES = 100;
const MAX_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 256;

const printedNames = new Set<string>();

/** Whether this process has yet to print the warning for this folded name. */
function firstPrint(folded: string): boolean {
  if (printedNames.has(folded) || printedNames.size >= MAX_REMEMBERED_NAMES) return false;
  printedNames.add(folded);
  return true;
}

/** For tests: every name prints again. */
export function forgetSecretNameWarnings(): void {
  printedNames.clear();
}

export interface SecretNameWarnings {
  /** The observer to pass to `redact` for one payload field. */
  observerFor(field: PayloadField): UnredactedObserver;
}

export function createSecretNameWarnings(options: {
  diagnostics: Diagnostics;
  /** Folded names the host says are not secrets. */
  knownSafeNames: ReadonlySet<string>;
  logDiagnostics: boolean;
}): SecretNameWarnings {
  const { diagnostics, knownSafeNames, logDiagnostics } = options;
  const reported = new Set<string>();

  function warn(field: PayloadField, name: string, path: string): void {
    const folded = normaliseName(name);
    if (knownSafeNames.has(folded) || reported.has(folded)) return;
    if (reported.size >= MAX_REMEMBERED_NAMES) return;
    reported.add(folded);

    const shownName = cut(name, MAX_NAME_LENGTH);
    const shownPath = cut(
      path.startsWith("[") ? `${field}${path}` : `${field}.${path}`,
      MAX_PATH_LENGTH
    );
    const diagnostic: Diagnostic = {
      kind: "unredacted_secret_name",
      reason:
        `A field named "${shownName}" (at ${shownPath}) looks like a secret and was sent unredacted. ` +
        `If it holds a secret, add "**.${shownName}" to the redact option; ` +
        `if it does not, add "${shownName}" to knownSafeNames.`,
      detail: { field, name: shownName, path: shownPath }
    };
    // Exempt from the log's rate limit: each line is a different name to fix,
    // and there are at most a hundred of them.
    diagnostics.report(diagnostic, undefined, { unlimited: true });
    // Printed once per process even with logging off, like the warnings SDK-56
    // and SDK-60 allow: a credential stored in the clear is otherwise silent to
    // anybody not reading diagnostics (SDK-40, SDK-61).
    if (!firstPrint(folded) || logDiagnostics) return;
    printDiagnostic(
      diagnostic,
      "printed once per process and name, whether or not logDiagnostics is on, because the value is stored in plain text"
    );
  }

  const observer =
    (field: PayloadField): UnredactedObserver =>
    (name, path) => {
      // Inside capture, whose failure would cost the payload: a warning must
      // never do that.
      try {
        warn(field, name, path);
      } catch {
        // The counters and the event are unaffected.
      }
    };
  // Made once rather than per capture, which runs on every recorded payload.
  const observers: Record<PayloadField, UnredactedObserver> = {
    input: observer("input"),
    output: observer("output"),
    metadata: observer("metadata")
  };

  return { observerFor: (field) => observers[field] };
}

/**
 * Plain key names from `knownSafeNames`, folded as redaction folds them, and
 * whether any entry could not be used. A path or a pattern is not a name: the
 * warning is about a name wherever it is filed.
 */
export function readKnownSafeNames(value: unknown): { names: string[]; problem?: string } {
  if (value === undefined) return { names: [] };
  if (!Array.isArray(value)) {
    return {
      names: [],
      problem: "knownSafeNames is not a list of key names; no name is exempt from the warning."
    };
  }
  const names = (value as unknown[])
    .filter((entry): entry is string => typeof entry === "string" && isPlainName(entry))
    .map((entry) => normaliseName(entry));
  return names.length === value.length
    ? { names }
    : {
        names,
        problem: "knownSafeNames holds entries that are not plain key names; they are ignored."
      };
}

function isPlainName(name: string): boolean {
  return name !== "" && !/[.*[\]]/.test(name);
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).toWellFormed();
}
