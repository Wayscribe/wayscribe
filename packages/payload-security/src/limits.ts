import { CIRCULAR } from "./redact.js";

export interface Limits {
  maxBytes: number;
  maxDepth: number;
  maxKeys: number;
  maxStringLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBytes: 262_144,
  maxDepth: 32,
  maxKeys: 1_000,
  maxStringLength: 65_536
};

export type LimitViolation =
  | "payload_too_large"
  | "max_depth_exceeded"
  | "max_keys_exceeded"
  | "max_string_length_exceeded"
  | "unserialisable_payload";

export type LimitResult = { ok: true } | { ok: false; reason: LimitViolation };

/**
 * Structural checks run before the byte check, because serializing a
 * pathologically nested or cyclic value in order to measure it is itself the
 * attack. SECURITY.md section 11 requires rejecting dangerous payloads before
 * expensive processing.
 */
export function checkLimits(value: unknown, limits: Limits): LimitResult {
  const structural = checkStructure(value, limits, 0, new WeakSet());
  if (!structural.ok) return structural;

  let bytes: number;
  try {
    // JSON.stringify is typed as returning string, but returns undefined for
    // `undefined` input. The cast acknowledges the lie in the lib types rather
    // than letting a runtime undefined reach Buffer.byteLength.
    const serialized = JSON.stringify(value, asStored()) as string | undefined;
    bytes = Buffer.byteLength(serialized ?? "", "utf8");
  } catch {
    // A getter or a toJSON that throws. Not a size problem, and calling it one
    // sent the operator to raise maxPayloadBytes, which cannot help.
    return { ok: false, reason: "unserialisable_payload" };
  }
  return bytes > limits.maxBytes ? { ok: false, reason: "payload_too_large" } : { ok: true };
}

/**
 * Measures the payload as `toStorable(redact(...))` will render it.
 *
 * A bare `JSON.stringify` throws on a cycle and on a BigInt, and both used to be
 * reported as `payload_too_large`. Both are storable — cycles are cut to a
 * marker and a BigInt becomes a decimal string — so the old measurement
 * rejected payloads the pipeline behind it handles perfectly well, and named
 * the wrong cause while doing it.
 *
 * `this` is the object currently being serialized, so unwinding it down to the
 * current holder leaves `ancestors` holding the path from the root. That
 * distinguishes a genuine loop from a shared reference, which must still be
 * expanded — counting it once would under-measure a payload that really is
 * twice the size.
 */
function asStored(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: object[] = [];

  return function replace(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return value;

    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return CIRCULAR;
    ancestors.push(value);
    return value;
  };
}

function checkStructure(
  value: unknown,
  limits: Limits,
  depth: number,
  seen: WeakSet<object>
): LimitResult {
  if (depth > limits.maxDepth) return { ok: false, reason: "max_depth_exceeded" };

  if (typeof value === "string") {
    return value.length > limits.maxStringLength
      ? { ok: false, reason: "max_string_length_exceeded" }
      : { ok: true };
  }

  if (value === null || typeof value !== "object") return { ok: true };

  // A cycle is not itself a violation here; it is cut so traversal terminates.
  // JSON.stringify below rejects it if it survives to serialization.
  if (seen.has(value)) return { ok: true };
  seen.add(value);

  const entries = Array.isArray(value) ? value : Object.values(value);
  const width = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (width > limits.maxKeys) return { ok: false, reason: "max_keys_exceeded" };

  for (const child of entries) {
    const result = checkStructure(child, limits, depth + 1, seen);
    if (!result.ok) return result;
  }
  return { ok: true };
}
