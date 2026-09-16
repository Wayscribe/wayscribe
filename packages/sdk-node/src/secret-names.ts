import { createHash } from "node:crypto";
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

/** A name the walk found in one payload, waiting to learn whether the payload is sent. */
export interface FoundName {
  name: string;
  path: string;
}

/**
 * How many distinct names are remembered, per recorder and per process. A
 * payload keyed by generated names (`vendor123Token`) must not grow the host's
 * memory, and a hundred warnings is already more than anyone reads.
 */
export const MAX_REMEMBERED_NAMES = 100;
const MAX_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 256;
/** Longer folded names are remembered by digest, not kept whole. */
const MAX_REMEMBERED_LENGTH = 256;

const printedNames = new Set<string>();

/** Whether this process has yet to print the warning for this name. */
function firstPrint(remembered: string): boolean {
  if (printedNames.has(remembered) || printedNames.size >= MAX_REMEMBERED_NAMES) return false;
  printedNames.add(remembered);
  return true;
}

/** For tests: every name prints again. */
export function forgetSecretNameWarnings(): void {
  printedNames.clear();
}

/**
 * What a name is remembered as: its folded form, or, for a long one, a digest
 * of it. Key names in a webhook are chosen by whoever sent it, and a hundred
 * remembered 200 KB names would be 20 MB the host never gets back.
 */
function rememberedForm(folded: string): string {
  return folded.length <= MAX_REMEMBERED_LENGTH
    ? folded
    : `#${createHash("sha256").update(folded).digest("base64")}`;
}

export interface SecretNameWarnings {
  /** The observer to pass to `redact` for one payload field; it only collects. */
  observerFor(field: PayloadField): UnredactedObserver;
  /** What the observer for this field collected since the last call. */
  take(field: PayloadField): FoundName[] | undefined;
  /** Warns about names found in a payload that is being sent. */
  report(field: PayloadField, found: readonly FoundName[]): void;
}

export function createSecretNameWarnings(options: {
  diagnostics: Diagnostics;
  /** Folded names the host says are not secrets. */
  knownSafeNames: ReadonlySet<string>;
  logDiagnostics: boolean;
}): SecretNameWarnings {
  const { diagnostics, knownSafeNames, logDiagnostics } = options;
  const reported = new Set<string>();
  const pending: Record<PayloadField, FoundName[]> = { input: [], output: [], metadata: [] };

  function collect(field: PayloadField, name: string, path: string): void {
    if (reported.size >= MAX_REMEMBERED_NAMES) return;
    const list = pending[field];
    // A payload with a thousand keys of one name is one warning, so the list
    // is bounded rather than kept per occurrence.
    if (list.length >= MAX_REMEMBERED_NAMES) return;
    const folded = normaliseName(name);
    if (knownSafeNames.has(folded) || reported.has(rememberedForm(folded))) return;
    list.push({ name, path });
  }

  function warn(field: PayloadField, name: string, path: string): void {
    const remembered = rememberedForm(normaliseName(name));
    if (reported.has(remembered) || reported.size >= MAX_REMEMBERED_NAMES) return;
    reported.add(remembered);

    const shownName = bounded(name, MAX_NAME_LENGTH);
    const shownPath = bounded(
      path.startsWith("[") ? `${field}${path}` : `${field}.${path}`,
      MAX_PATH_LENGTH
    );
    const diagnostic: Diagnostic = {
      kind: "unredacted_secret_name",
      code: "secret_like_name",
      reason:
        `A field named "${shownName}" (at ${shownPath}) looks like a secret and was sent unredacted. ` +
        advice(shownName),
      detail: { field, name: shownName, path: shownPath }
    };
    // Exempt from the log's rate limit: each line is a different name to fix,
    // and there are at most a hundred of them.
    diagnostics.report(diagnostic, undefined, { unlimited: true });
    // Printed once per process even with logging off, like the warnings SDK-56
    // and SDK-60 allow: a credential stored in the clear is otherwise silent to
    // anybody not reading diagnostics (SDK-40, SDK-61).
    if (!firstPrint(remembered) || logDiagnostics) return;
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
        collect(field, name, path);
      } catch {
        // The event is unaffected.
      }
    };
  // Made once rather than per capture, which runs on every recorded payload.
  const observers: Record<PayloadField, UnredactedObserver> = {
    input: observer("input"),
    output: observer("output"),
    metadata: observer("metadata")
  };

  return {
    observerFor: (field) => observers[field],
    take(field) {
      const found = pending[field];
      if (found.length === 0) return undefined;
      pending[field] = [];
      return found;
    },
    report(field, found) {
      for (const { name, path } of found) {
        try {
          warn(field, name, path);
        } catch {
          // As in collect: the event is sent whatever happens here.
        }
      }
    }
  };
}

/** Characters the redaction grammar reads as structure, so no rule can name them. */
const RULE_SYNTAX = /[.*[\]]/;

function advice(name: string): string {
  if (RULE_SYNTAX.test(name)) {
    return (
      'No redaction rule can name a key containing ".", "*", "[" or "]": if it holds a secret, ' +
      "rename it or leave it out of what you record; " +
      `if it does not, add "${name}" to knownSafeNames.`
    );
  }
  return (
    `If it holds a secret, add "**.${name}" to the redact option; ` +
    `if it does not, add "${name}" to knownSafeNames.`
  );
}

/**
 * Key names from `knownSafeNames`, folded as redaction folds them, and whether
 * any entry could not be used. Any non-empty string is a name, including one
 * with `.` or `*` in it: a name the redaction grammar cannot express still has
 * to be quietable.
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
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .map((entry) => normaliseName(entry));
  return names.length === value.length
    ? { names }
    : { names, problem: "knownSafeNames holds entries that are not key names; they are ignored." };
}

/**
 * The text, cut, as a string of its own. A slice of a long string can keep the
 * whole of it alive, and these are handed to `onDiagnostic`, which may keep
 * them for as long as it likes.
 */
function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text.slice(0, max).toWellFormed()).join("");
}
