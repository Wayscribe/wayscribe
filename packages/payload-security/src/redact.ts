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
 *   authorization         matched case-insensitively
 *
 * Regular-expression paths and conditional rules are out of scope, so operators
 * are never left guessing what a rule will match.
 *
 * Matched values are replaced rather than deleted: SECURITY.md section 4
 * requires preserving evidence that a value existed.
 */
export function redact(value: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return value;
  return walk(value, paths.map(parsePath), new Set());
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
function walk(value: unknown, paths: Segment[][], seen: Set<object>): unknown {
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
      return walk(serialized.value, paths, seen);
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
      return value.map((item) =>
        remaining.length > 0 ? walkOrRedact(item, remaining, seen) : walk(item, [], seen)
      );
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const matching = paths.filter((path) => matches(path[0], key)).map((path) => path.slice(1));

      result[key] = matching.some((path) => path.length === 0)
        ? REDACTED
        : walkOrRedact(child, matching, seen);
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

function walkOrRedact(value: unknown, paths: Segment[][], seen: Set<object>): unknown {
  return paths.some((path) => path.length === 0) ? REDACTED : walk(value, paths, seen);
}

function matches(segment: Segment | undefined, key: string): boolean {
  if (segment === undefined) return false;
  if (segment.kind === "any") return true;
  if (segment.kind === "arrayAny") return false;
  return segment.value === key.toLowerCase();
}
