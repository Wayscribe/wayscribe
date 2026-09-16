import { renderExotic } from "./exotic.js";
import {
  isInterleavedHeaders,
  isKnownHeaderName,
  isNamedPair,
  maskHeaderLines,
  namedValueKey
} from "./http-headers.js";
import { normaliseName } from "./normalise-name.js";
import { looksLikeSecretFoldedValue } from "./secret-name.js";

export { normaliseName };

export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[CIRCULAR]";

type Segment = { kind: "literal"; value: string } | { kind: "any" } | { kind: "arrayAny" };

/**
 * Redact configured paths from a structure.
 *
 * The supported grammar is intentionally small and exhaustive:
 *
 *   customer.ssn          literal segments
 *   *.password            one level of anything
 *   items[*].cardNumber   array elements
 *   authorization         at the top level; case and separators ignored
 *   {@link ANY_DEPTH_PREFIX}authorization   that key name wherever it appears
 *
 * Regular-expression paths and conditional rules are out of scope, so operators
 * are never left guessing what a rule will match.
 *
 * The any-depth form exists because a path rule cannot express the thing a
 * secret list actually needs to say. `authorization` reached the top level and
 * `*.authorization` reached one below it, so `config.headers.authorization` —
 * what every axios error carries — was stored in the clear, as was anything
 * inside an array, since an array with no matching `x[*]` rule was walked with
 * no rules at all. A secret is identified by the name it is filed under, not by
 * where in a request somebody happened to nest it.
 *
 * Only a plain key name is supported after the prefix. Anything else is dropped
 * rather than reinterpreted, so an unsupported rule protects nothing instead of
 * quietly matching something its author did not mean.
 *
 * Matched values are replaced rather than deleted: SECURITY.md section 4
 * requires preserving evidence that a value existed.
 *
 * `onUnredacted`, when given, is called for each name the walk kept, as an
 * object key or in one of the header shapes above, whose value could be a
 * credential by `looksLikeSecretValue`. It receives the name as written and
 * the path to it, with every array index written `[*]`, and never the value. It is how a
 * name no rule covers is warned about without a second walk (ADR-055); it
 * changes nothing about what is returned. An observer that throws ends the
 * walk, so a caller that must not fail guards it.
 */
export function redact(
  value: unknown,
  paths: readonly string[],
  onUnredacted?: UnredactedObserver
): unknown {
  if (paths.length === 0 && onUnredacted === undefined) return value;

  const { anyDepth, scoped } = compiled(paths);

  let observed: Observed | undefined;
  if (onUnredacted !== undefined) {
    const made: Observed = {
      report: onUnredacted,
      path: [],
      onHeaderLine: (name, lineValue) => {
        reportIfSecret(made, name, lineValue);
      }
    };
    observed = made;
  }
  return walk(value, scoped, anyDepth, new Set(), observed);
}

interface CompiledRules {
  anyDepth: ReadonlySet<string>;
  scoped: Segment[][];
}

const compiledFrozen = new WeakMap<readonly string[], CompiledRules>();

/**
 * The rules parsed. A frozen list, which is what the SDK passes to every
 * capture, is parsed once: parsing nineteen rules on every payload was a
 * measurable part of capture. A list that is not frozen can change between
 * calls, so it is parsed each time.
 */
function compiled(paths: readonly string[]): CompiledRules {
  const frozen = Object.isFrozen(paths);
  const cached = frozen ? compiledFrozen.get(paths) : undefined;
  if (cached !== undefined) return cached;

  const anyDepth = new Set<string>();
  const scoped: Segment[][] = [];
  for (const path of paths) {
    if (path.startsWith(ANY_DEPTH_PREFIX)) {
      const name = anyDepthName(path);
      if (name !== undefined) anyDepth.add(name);
      continue;
    }
    scoped.push(parsePath(path));
  }
  const rules = { anyDepth, scoped };
  if (frozen) compiledFrozen.set(paths, rules);
  return rules;
}

/** Told the name and generalised path of a kept value filed under a secret-looking name. */
export type UnredactedObserver = (name: string, path: string) => void;

/**
 * The observer, and the key path to the value being walked.
 *
 * The path is a stack pushed on the way down and popped on the way up, and
 * joined only when something is reported, so an ordinary payload costs one
 * push and pop per key and no string building.
 */
interface Observed {
  report: UnredactedObserver;
  path: string[];
  /** For a header block's kept lines; made once per call, not per string. */
  onHeaderLine: (name: string, value: string) => void;
}

const ANY_INDEX = "[*]";

function joinPath(path: readonly string[]): string {
  let joined = "";
  for (const segment of path) {
    joined += segment === ANY_INDEX || joined === "" ? segment : `.${segment}`;
  }
  return joined;
}

function reportIfSecret(observed: Observed, name: string, value: unknown): void {
  if (looksLikeSecretFoldedValue(normaliseName(name), value)) {
    observed.report(name, joinPath(observed.path));
  }
}

/** Marks a rule that applies at every level rather than at one path. */
const ANY_DEPTH_PREFIX = "**.";

/** The key name in an any-depth rule, or undefined if the rule is malformed. */
function anyDepthName(path: string): string | undefined {
  const name = path.slice(ANY_DEPTH_PREFIX.length);
  return name === "" || /[.*[\]]/.test(name) ? undefined : normaliseName(name);
}

function parsePath(path: string): Segment[] {
  return path.split(".").flatMap((raw): Segment[] => {
    const arrayMatch = /^(.*)\[\*\]$/.exec(raw);
    if (arrayMatch) {
      return [toSegment(arrayMatch[1] ?? ""), { kind: "arrayAny" }];
    }
    return [toSegment(raw)];
  });
}

function toSegment(raw: string): Segment {
  return raw === "*" ? { kind: "any" } : { kind: "literal", value: normaliseName(raw) };
}

/**
 * `seen` holds the current *ancestor chain*, not everything ever visited.
 *
 * A single accumulating set cannot tell a cycle from a shared reference. Two
 * fields pointing at one address object — entirely ordinary — reported the
 * second as [CIRCULAR], which the diff then showed as a change to a field that
 * had not changed. Entries are added on the way down and removed on the way
 * back up, so only a genuine loop is caught.
 */
function walk(
  value: unknown,
  paths: Segment[][],
  anyDepth: ReadonlySet<string>,
  seen: Set<object>,
  observed?: Observed
): unknown {
  if (typeof value === "string") {
    // A serialised header block, such as a ClientRequest's `_header`, files a
    // header under a line rather than a key. Only its secret-named lines are
    // masked, never the string by shape (ADR-046).
    if (anyDepth.size === 0) return value;
    return maskHeaderLines(
      value,
      (name) => anyDepth.has(normaliseName(name)),
      REDACTED,
      observed?.onHeaderLine
    );
  }
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return CIRCULAR;

  // Anything that knows how to serialize itself is asked to, and the result is
  // walked so redaction still applies. Rebuilding these from Object.entries
  // silently destroyed them: a Date has no own enumerable properties, so it
  // became `{}` and its toJSON went with the prototype.
  const serialized = selfSerialized(value);
  if (serialized !== undefined) {
    seen.add(value);
    try {
      return walk(serialized.value, paths, anyDepth, seen, observed);
    } finally {
      seen.delete(value);
    }
  }

  // Values whose contents live in internal slots rather than in own enumerable
  // properties. Rendered shallowly and fed straight back through this same
  // walk, with the paths un-advanced, so a secret inside a Map is matched by
  // the code that matches one inside an object — and the key it is stored under
  // is the key a rule can name.
  const exotic = renderExotic(value);
  if (exotic !== undefined) {
    seen.add(value);
    try {
      return walk(exotic.value, paths, anyDepth, seen, observed);
    } finally {
      seen.delete(value);
    }
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const remaining = paths
        .filter((path) => path[0]?.kind === "arrayAny")
        .map((path) => path.slice(1));
      // Descends even with nothing remaining. Returning early here is what let
      // an array swallow the rules: elements were walked with no paths, so a
      // secret one level inside a list was never examined again.
      if (remaining.some((path) => path.length === 0)) return value.map(() => REDACTED);

      // Headers filed by position rather than by key: Node's `rawHeaders` as
      // `[name, value, ...]`, fetch's `[[name, value], ...]`, and HAR's
      // `[{ name, value }, ...]`. An any-depth name covers them as it covers a
      // key, or `Authorization` in a header tuple was stored verbatim in the
      // default capture mode. A value that is itself a header name is kept,
      // because that list is configuration, not headers.
      const isSecretName = (name: string): boolean => anyDepth.has(normaliseName(name));
      const replaces = (name: string, child: unknown): boolean =>
        isSecretName(name) && !isKnownHeaderName(child);
      const interleaved = anyDepth.size > 0 && isInterleavedHeaders(value);
      return value.map((item, index) => {
        // A header filed by position and kept: its name and value, for the
        // secret-name warning. Read here, once, with the shape tests redaction
        // already makes. An interleaved list holds only strings, so the pair
        // and object shapes never apply to it.
        let headerName: unknown;
        let headerValue: unknown;
        if (anyDepth.size > 0) {
          if (interleaved) {
            if (index % 2 === 1) {
              if (replaces(value[index - 1] as string, item)) return REDACTED;
              headerName = value[index - 1];
              headerValue = item;
            }
          } else if (isNamedPair(item)) {
            if (replaces(item[0], item[1])) return [item[0], REDACTED];
            [headerName, headerValue] = item;
          } else {
            const nameKey = namedValueKey(item);
            const entry = item as Record<string, unknown>;
            if (nameKey !== undefined && replaces(entry[nameKey] as string, entry["value"])) {
              // Rebuilt rather than mutated, and every key written with
              // `defineKey`: a `__proto__` key beside the pair reaches this
              // branch now that an extra key no longer exempts the object, and
              // an assignment would spend it on the prototype.
              const replaced: Record<string, unknown> = {};
              for (const key of Object.keys(entry)) {
                defineKey(replaced, key, key === "value" ? REDACTED : entry[key]);
              }
              return replaced;
            }
            if (nameKey !== undefined) {
              headerName = entry[nameKey];
              headerValue = entry["value"];
            }
          }
        }
        if (observed === undefined) return walk(item, remaining, anyDepth, seen);
        observed.path.push(ANY_INDEX);
        // A name a rule covers is left alone, including one kept because its
        // value is itself a header name.
        if (typeof headerName === "string" && !isSecretName(headerName)) {
          reportIfSecret(observed, headerName, headerValue);
        }
        const walked = walk(item, remaining, anyDepth, seen, observed);
        observed.path.pop();
        return walked;
      });
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // `anyDepth` is checked at every level and never narrowed on the way
      // down, which is the whole of its guarantee: a key on this list is
      // replaced wherever it is filed.
      const name = normaliseName(key);
      if (anyDepth.has(name)) {
        defineKey(result, key, REDACTED);
        continue;
      }

      const matching = paths.filter((path) => matches(path[0], key)).map((path) => path.slice(1));
      if (matching.some((path) => path.length === 0)) {
        defineKey(result, key, REDACTED);
        continue;
      }

      if (observed === undefined) {
        defineKey(result, key, walk(child, matching, anyDepth, seen));
        continue;
      }
      // Kept, so a warning is due if the name reads as a secret. The type test
      // comes first because it is cheaper than the name test. No `finally`
      // around the push: the stack belongs to this one call of `redact`, and
      // a throw abandons it along with the call.
      observed.path.push(key);
      if (looksLikeSecretFoldedValue(name, child)) {
        observed.report(key, joinPath(observed.path));
      }
      defineKey(result, key, walk(child, matching, anyDepth, seen, observed));
      observed.path.pop();
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * The value's own JSON representation, when it has one.
 *
 * Wrapped in a result object so a `toJSON` legitimately returning `undefined`
 * is distinguishable from "no toJSON here". A throwing `toJSON` falls through
 * to the ordinary rebuild rather than escaping into the host application.
 */
function selfSerialized(value: object): { value: unknown } | undefined {
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson !== "function") return undefined;

  try {
    return { value: (toJson as () => unknown).call(value) };
  } catch {
    return undefined;
  }
}

/**
 * Writes a key onto a rebuilt object, including the one key assignment cannot.
 *
 * `JSON.parse` makes `__proto__` an ordinary own enumerable key, so any webhook
 * body can carry one, and `result[key] = child` then spends it on the object's
 * prototype rather than storing it. The field disappeared from the recorded
 * payload — silently, and from a tool whose entire promise is showing what the
 * payload actually was.
 *
 * The name is compared before the slow path so ordinary keys stay a plain
 * assignment. `Object.create(null)` for every rebuilt object would fix the same
 * bug at more than ten times the cost, in a walk that runs inside the
 * instrumented application's own process.
 */
export function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
    return;
  }
  target[key] = value;
}

function matches(segment: Segment | undefined, key: string): boolean {
  if (segment === undefined) return false;
  if (segment.kind === "any") return true;
  if (segment.kind === "arrayAny") return false;
  return segment.value === normaliseName(key);
}
