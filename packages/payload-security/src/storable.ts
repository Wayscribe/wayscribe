import { CIRCULAR, defineKey } from "./redact.js";

/** NUL. PostgreSQL rejects it in `text` and in `jsonb` alike. */
const NUL = "\u0000";

/**
 * Make a string storable as PostgreSQL `jsonb`.
 *
 * Two ordinary strings are not storable: one containing a NUL byte, and one
 * containing a lone surrogate — the trailing half of an emoji or CJK character
 * left behind by a `name.slice(0, 20)` upstream, or a NUL from a fixed-width
 * export.
 *
 * Neither is exotic and neither is the instrumented application's fault, but
 * both reach the database as an invalid cast, and that failure used to take the
 * whole batch with it.
 *
 * Repairing is better than refusing. The point of recording a payload is to
 * show what actually arrived, and "this name held a broken character" is
 * precisely the sort of thing somebody is trying to debug.
 */
export function toStorableText(text: string): string {
  // Removed rather than replaced: no substitute round-trips, and a marker in
  // the middle of a value would be a worse lie than a missing byte.
  const withoutNul = text.includes(NUL) ? text.replaceAll(NUL, "") : text;
  // Lone surrogates become U+FFFD, which is what the replacement character is
  // for and what a reader needs to see.
  return withoutNul.toWellFormed();
}

/**
 * Applies {@link toStorableText} to every string in a structure, and renders the
 * two remaining values `JSON.stringify` refuses.
 *
 * A BigInt throws outright — and a Postgres `bigint` column, a Prisma `BigInt`,
 * and a snowflake id are all ordinary. Rendering one as a decimal string keeps
 * the digits BigInt exists to protect; a Number would round them away.
 *
 * A cycle overflows the stack. `redact` marks cycles already, but only when the
 * caller configured at least one path, so this is the path a bare
 * `toStorable(value)` takes.
 */
export function toStorable(value: unknown): unknown {
  return walk(value, new Set());
}

/**
 * `seen` is the ancestor chain, not everything visited: two fields pointing at
 * one address object is ordinary, and calling the second [CIRCULAR] would show
 * up in the diff as a change to a field that never changed.
 */
function walk(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "string") return toStorableText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((child) => walk(child, seen));

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // Keys too: a NUL in a key is as unstorable as one in a value, and jsonb
      // rejects the whole document either way.
      defineKey(result, toStorableText(key), walk(child, seen));
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
