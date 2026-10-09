import type { DiffChange } from "./api";

/**
 * Reads a structural diff the way a person debugging a transformation would.
 *
 * The diff (`@wayscribe/payload-diff`) compares by path, so a transformation
 * that renames `Phone` to `phone` reads as one field removed and another
 * added. A step that renames every field turns into a column of unrelated
 * rows, and the one row that matters (a value that became null) looks like
 * every expected rename around it. This pairs those rows back up and puts the
 * damage first. Display only: the stored diff and the API's answer keep their
 * three kinds.
 *
 * Pairing, within one parent object only:
 * 1. by name: a removed and an added key that normalize equal (`normalizeKey`);
 * 2. then by value: a removed and an added key whose values are deep-equal,
 *    when neither side has another candidate with that value. A null value is
 *    never paired by value: two nulls are no evidence of a rename.
 * Either way a pair is accepted only when the match is unique on both sides,
 * so an ambiguous diff is shown as it is rather than guessed at.
 *
 * Array elements are never paired: arrays are compared by index (ADR-025), so
 * `tags[2]` and `tags[3]` are positions, not names.
 *
 * Paths are split at their last `.`, the separator the diff writes. A key
 * that itself contains a `.` is split wrongly, and at worst stays unpaired.
 */

export type DisplayKind = "added" | "removed" | "changed" | "renamed" | "renamed-changed";

export interface PairedChange {
  /** The path in the output for a rename; otherwise the change's own path. */
  path: string;
  /** The path in the input for a rename; null for any other kind. */
  from: string | null;
  kind: DisplayKind;
  /** Undefined when the input did not have the field. */
  before: unknown;
  /** Undefined when the output does not have the field. */
  after: unknown;
  /** The input had a non-null value and the output has null or nothing. */
  lost: boolean;
}

/** Lowercase, drop a trailing Salesforce custom-field `__c`, drop `_` and `-`. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/__c$/, "").replace(/[_-]/g, "");
}

interface Side {
  index: number;
  change: DiffChange;
  parent: string;
  key: string;
}

/** The parent path and final object key, or null for an array element or the root. */
function splitPath(path: string): { parent: string; key: string } | null {
  if (path === "" || path.endsWith("]")) return null;
  const dot = path.lastIndexOf(".");
  return dot === -1
    ? { parent: "", key: path }
    : { parent: path.slice(0, dot), key: path.slice(dot + 1) };
}

/** As the diff compares: identical, or the same JSON. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isLost(before: unknown, after: unknown): boolean {
  return before !== undefined && before !== null && (after === undefined || after === null);
}

/** Lost first, then altered values, then fields that only came or went, then quiet renames. */
function rank(row: PairedChange): number {
  if (row.lost) return 0;
  if (row.kind === "changed" || row.kind === "renamed-changed") return 1;
  if (row.kind === "added" || row.kind === "removed") return 2;
  return 3;
}

/**
 * Pairs one pass's unique matches. `matches` says whether a removed and an
 * added side are candidates; a pair is made only when each is the other's
 * one candidate among the sides still unpaired.
 */
function pairPass(
  removed: Side[],
  added: Side[],
  matches: (r: Side, a: Side) => boolean,
  pairs: Map<Side, Side>
): void {
  const openAdded = added.filter((a) => ![...pairs.values()].includes(a));
  const openRemoved = removed.filter((r) => !pairs.has(r));
  const found: [Side, Side][] = [];
  for (const r of openRemoved) {
    const candidates = openAdded.filter((a) => a.parent === r.parent && matches(r, a));
    const [a] = candidates;
    if (candidates.length !== 1 || a === undefined) continue;
    const rivals = openRemoved.filter((other) => other.parent === a.parent && matches(other, a));
    if (rivals.length === 1) found.push([r, a]);
  }
  for (const [r, a] of found) pairs.set(r, a);
}

export function pairChanges(changes: readonly DiffChange[]): PairedChange[] {
  const removed: Side[] = [];
  const added: Side[] = [];
  changes.forEach((change, index) => {
    if (change.kind === "changed") return;
    const split = splitPath(change.path);
    if (split === null) return;
    (change.kind === "removed" ? removed : added).push({ index, change, ...split });
  });

  const pairs = new Map<Side, Side>();
  pairPass(removed, added, (r, a) => normalizeKey(r.key) === normalizeKey(a.key), pairs);
  pairPass(
    removed,
    added,
    (r, a) =>
      r.change.before !== null &&
      r.change.before !== undefined &&
      deepEqual(r.change.before, a.change.after),
    pairs
  );

  const pairedRemovedByIndex = new Map([...pairs].map(([r, a]) => [r.index, a]));
  const pairedAddedIndexes = new Set([...pairs.values()].map((a) => a.index));

  const rows: { order: number; row: PairedChange }[] = [];
  changes.forEach((change, index) => {
    if (pairedAddedIndexes.has(index)) return;
    const partner = pairedRemovedByIndex.get(index);
    if (partner !== undefined) {
      const before = change.before;
      const after = partner.change.after;
      rows.push({
        order: Math.min(index, partner.index),
        row: {
          path: partner.change.path,
          from: change.path,
          kind: deepEqual(before, after) ? "renamed" : "renamed-changed",
          before,
          after,
          lost: isLost(before, after)
        }
      });
      return;
    }
    rows.push({
      order: index,
      row: {
        path: change.path,
        from: null,
        kind: change.kind,
        before: change.before,
        after: change.after,
        lost: isLost(change.before, change.after)
      }
    });
  });

  return rows.sort((x, y) => rank(x.row) - rank(y.row) || x.order - y.order).map(({ row }) => row);
}
