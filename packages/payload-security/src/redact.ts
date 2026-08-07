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
  return walk(value, paths.map(parsePath), new WeakSet());
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

function walk(value: unknown, paths: Segment[][], seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

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
}

function walkOrRedact(value: unknown, paths: Segment[][], seen: WeakSet<object>): unknown {
  return paths.some((path) => path.length === 0) ? REDACTED : walk(value, paths, seen);
}

function matches(segment: Segment | undefined, key: string): boolean {
  if (segment === undefined) return false;
  if (segment.kind === "any") return true;
  if (segment.kind === "arrayAny") return false;
  return segment.value === key.toLowerCase();
}
