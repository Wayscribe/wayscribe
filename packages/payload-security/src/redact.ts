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
 *   authorization         matched case-insensitively, at the top level
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
  return name === "" || /[.*[\]]/.test(name) ? undefined : name.toLowerCase();
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
  return raw === "*" ? { kind: "any" } : { kind: "literal", value: raw.toLowerCase() };
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

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const remaining = paths
        .filter((path) => path[0]?.kind === "arrayAny")
        .map((path) => path.slice(1));
      // Descends even with nothing remaining. Returning early here is what let
      // an array swallow the rules: elements were walked with no paths, so a
      // secret one level inside a list was never examined again.
      return value.map((item) => walkOrRedact(item, remaining, anyDepth, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // `anyDepth` is checked at every level and never narrowed on the way
      // down, which is the whole of its guarantee: a key on this list is
      // replaced wherever it is filed.
      if (anyDepth.has(key.toLowerCase())) {
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
  return segment.value === key.toLowerCase();
}
