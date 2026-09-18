/**
 * A list setting read without running anything of the host's but property
 * reads, each inside the boundary (SDK-6).
 *
 * `filter`, `map`, spread and `for...of` on the host's array all run the
 * host's code: an overridden method, a `Symbol.species` constructor, a
 * Proxy's traps or an iterator. Each could hand back a value whose later use
 * throws outside any boundary, and a `length` of a trillion made `filter`
 * run for as long as the process lived. So the entries are copied by index,
 * at most `max` of them, into a fresh plain array, and only that copy is
 * used afterwards.
 */

/** What reading a list setting found. */
export type HostList =
  /** Not given. */
  | { kind: "absent" }
  /** Not an array. */
  | { kind: "not_a_list" }
  /** `Array.isArray`, `length` or an entry threw, or `length` is not a length. */
  | { kind: "unreadable" }
  /**
   * The entries, as a plain array the SDK owns, and whether the list held
   * more than were kept.
   */
  | { kind: "list"; entries: unknown[]; cut: boolean };

export function readHostList(value: unknown, max: number): HostList {
  if (value === undefined) return { kind: "absent" };
  try {
    if (!Array.isArray(value)) return { kind: "not_a_list" };
    const length: unknown = (value as { length: unknown }).length;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      return { kind: "unreadable" };
    }
    const kept = Math.min(length, max);
    const entries: unknown[] = [];
    for (let index = 0; index < kept; index += 1) {
      entries.push((value as Record<number, unknown>)[index]);
    }
    return { kind: "list", entries, cut: length > max };
  } catch {
    return { kind: "unreadable" };
  }
}
