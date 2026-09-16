import { renderExotic } from "./exotic.js";
import {
  isInterleavedHeaders,
  isKnownHeaderName,
  isNamedPair,
  maskHeaderLines,
  namedValueKey
} from "./http-headers.js";
import { normaliseName } from "./normalise-name.js";

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
 */
export function redact(value: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return value;

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

  return walk(value, scoped, anyDepth, new Set());
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
  seen: Set<object>
): unknown {
  if (typeof value === "string") {
    // A serialised header block, such as a ClientRequest's `_header`, files a
    // header under a line rather than a key. Only its secret-named lines are
    // masked, never the string by shape (ADR-046).
    return anyDepth.size === 0
      ? value
      : maskHeaderLines(value, (name) => anyDepth.has(normaliseName(name)), REDACTED);
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
      return walk(serialized.value, paths, anyDepth, seen);
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
      return walk(exotic.value, paths, anyDepth, seen);
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
        if (anyDepth.size > 0) {
          if (interleaved && index % 2 === 1 && replaces(value[index - 1] as string, item)) {
            return REDACTED;
          }
          if (isNamedPair(item) && replaces(item[0], item[1])) return [item[0], REDACTED];
          const nameKey = namedValueKey(item);
          if (nameKey !== undefined) {
            const entry = item as Record<string, unknown>;
            if (replaces(entry[nameKey] as string, entry["value"])) {
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
          }
        }
        return walk(item, remaining, anyDepth, seen);
      });
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // `anyDepth` is checked at every level and never narrowed on the way
      // down, which is the whole of its guarantee: a key on this list is
      // replaced wherever it is filed.
      if (anyDepth.has(normaliseName(key))) {
        defineKey(result, key, REDACTED);
        continue;
      }

      const matching = paths.filter((path) => matches(path[0], key)).map((path) => path.slice(1));

      defineKey(
        result,
        key,
        matching.some((path) => path.length === 0)
          ? REDACTED
          : walkOrRedact(child, matching, anyDepth, seen)
      );
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

function walkOrRedact(
  value: unknown,
  paths: Segment[][],
  anyDepth: ReadonlySet<string>,
  seen: Set<object>
): unknown {
  return paths.some((path) => path.length === 0) ? REDACTED : walk(value, paths, anyDepth, seen);
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
