export type ChangeKind = "added" | "removed" | "changed";

export interface Change {
  path: string;
  kind: ChangeKind;
  before?: unknown;
  after?: unknown;
}

export interface DiffResult {
  changes: Change[];
  truncated: boolean;
}

export interface DiffOptions {
  maxChanges?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_CHANGES = 500;
const DEFAULT_MAX_DEPTH = 32;

/**
 * Structural comparison of two JSON-compatible values.
 *
 * Arrays compare element-wise by index (ADR-025): a reordered array reads as
 * broadly changed. Subsequence matching is O(n*m) against a specification that
 * demands explicit complexity limits.
 *
 * Callers pass values that have already been redacted, so a redacted field
 * compares "[REDACTED]" against "[REDACTED]" and reads as unchanged. That is
 * intended — a diff must never become a channel for a secret — but it means a
 * diff cannot prove a credential did not rotate.
 */
export function diffPayloads(
  before: unknown,
  after: unknown,
  options: DiffOptions = {}
): DiffResult {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const changes: Change[] = [];
  const truncated = walk(before, after, "", changes, maxChanges, maxDepth, 0);
  return { changes, truncated };
}

/** Returns true when the change budget or depth limit was hit. */
function walk(
  before: unknown,
  after: unknown,
  path: string,
  changes: Change[],
  maxChanges: number,
  maxDepth: number,
  depth: number
): boolean {
  if (changes.length >= maxChanges) return true;
  if (depth > maxDepth) return true;
  if (Object.is(before, after)) return false;

  if (isPlainObject(before) && isPlainObject(after)) {
    return walkObject(before, after, path, changes, maxChanges, maxDepth, depth);
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    return walkArray(before, after, path, changes, maxChanges, maxDepth, depth);
  }

  if (!deepEqual(before, after)) {
    changes.push({ path, kind: "changed", before, after });
  }
  return changes.length >= maxChanges;
}

function walkObject(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
  changes: Change[],
  maxChanges: number,
  maxDepth: number,
  depth: number
): boolean {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (changes.length >= maxChanges) return true;
    const childPath = path === "" ? key : `${path}.${key}`;
    const inBefore = key in before;
    const inAfter = key in after;

    if (inBefore && !inAfter) {
      changes.push({ path: childPath, kind: "removed", before: before[key] });
    } else if (!inBefore && inAfter) {
      changes.push({ path: childPath, kind: "added", after: after[key] });
    } else if (walk(before[key], after[key], childPath, changes, maxChanges, maxDepth, depth + 1)) {
      return true;
    }
  }
  return changes.length >= maxChanges;
}

function walkArray(
  before: unknown[],
  after: unknown[],
  path: string,
  changes: Change[],
  maxChanges: number,
  maxDepth: number,
  depth: number
): boolean {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (changes.length >= maxChanges) return true;
    const childPath = `${path}[${String(index)}]`;

    if (index >= after.length) {
      changes.push({ path: childPath, kind: "removed", before: before[index] });
    } else if (index >= before.length) {
      changes.push({ path: childPath, kind: "added", after: after[index] });
    } else if (
      walk(before[index], after[index], childPath, changes, maxChanges, maxDepth, depth + 1)
    ) {
      return true;
    }
  }
  return changes.length >= maxChanges;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
