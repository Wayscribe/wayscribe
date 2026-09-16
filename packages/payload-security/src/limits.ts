import { renderExotic } from "./exotic.js";
import { CIRCULAR } from "./redact.js";
import { MAX_STRING_LENGTH, truncateText } from "./truncate.js";

export interface Limits {
  maxBytes: number;
  maxDepth: number;
  maxKeys: number;
  maxStringLength: number;
  /**
   * Measure every string as `truncateText` will leave it at this length, and do
   * not count a longer one as a violation.
   *
   * For a payload that is about to be truncated: the check then answers "will
   * this fit once it is cut", with the same checker rather than a second
   * measurement.
   */
  truncateStringsTo?: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBytes: 262_144,
  maxDepth: 32,
  maxKeys: 1_000,
  maxStringLength: MAX_STRING_LENGTH
};

/**
 * How far below an envelope's root a payload sits: `envelope.event.input`.
 *
 * The depth limit is measured from the envelope's root, so a payload has two
 * levels fewer than the limit says.
 */
export const PAYLOAD_DEPTH = 2;

/**
 * The limits ingestion applies to one envelope.
 *
 * The API calls exactly this, and so does the SDK before it sends, which is how
 * the two agree: an event the SDK sends is one this check has already passed.
 * `maxEventBytes` is `MAX_EVENT_PAYLOAD_BYTES` on the server and
 * `maxEventBytes` in the SDK, and the two should be set to the same number.
 */
export function eventLimits(maxEventBytes: number): Limits {
  return { ...DEFAULT_LIMITS, maxBytes: maxEventBytes };
}

/**
 * The same limits as they fall on one payload about to be truncated.
 *
 * Two levels shallower, because that is where a payload sits; and with strings
 * measured as truncated, because they will be. A payload that fails this cannot
 * be made to fit by cutting strings and is omitted instead. A payload that
 * passes may still be omitted once the whole envelope is measured, since the
 * byte budget is shared by everything on the event.
 */
export function payloadLimits(maxEventBytes: number): Limits {
  return {
    ...eventLimits(maxEventBytes),
    maxDepth: DEFAULT_LIMITS.maxDepth - PAYLOAD_DEPTH,
    truncateStringsTo: DEFAULT_LIMITS.maxStringLength
  };
}

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
    const serialized = JSON.stringify(value, asStored(limits.truncateStringsTo)) as
      string | undefined;
    bytes = Buffer.byteLength(serialized ?? "", "utf8");
  } catch {
    // A getter or a toJSON that throws. Not a size problem, and calling it one
    // sent the operator to raise maxEventBytes, which cannot help.
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
 *
 * With `truncateTo`, a string is measured as `truncateText` will leave it.
 */
function asStored(
  truncateTo: number | undefined
): (this: unknown, key: string, value: unknown) => unknown {
  const text = (value: string): string =>
    truncateTo === undefined ? value : truncateText(value, truncateTo);
  const ancestors: object[] = [];
  // One rendering per value, reused. Not an optimisation: the cycle check below
  // compares by identity, and rendering the same Map twice would produce two
  // objects, so a loop through a Map would never close and the measurement
  // would recurse until the stack gave out.
  const renders = new WeakMap<object, object>();

  return function replace(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string") return text(value);
    if (value === null || typeof value !== "object") return value;

    let target: object = value;
    const memo = renders.get(value);
    if (memo !== undefined) {
      target = memo;
    } else {
      // JSON.stringify sees no own enumerable properties on a Map, so it
      // measured one as `{}` — two bytes for something now stored in full. The
      // guard has to weigh what will be stored, not what the value looks like.
      const exotic = renderExotic(value);
      if (exotic !== undefined) {
        if (typeof exotic.value === "string") return text(exotic.value);
        if (typeof exotic.value !== "object" || exotic.value === null) return exotic.value;
        target = exotic.value;
        renders.set(value, target);
      }
    }

    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(target)) return CIRCULAR;
    ancestors.push(target);
    return target;
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
    // A string that will be cut before it is sent is not a violation; the byte
    // check below measures it as cut.
    return limits.truncateStringsTo === undefined && value.length > limits.maxStringLength
      ? { ok: false, reason: "max_string_length_exceeded" }
      : { ok: true };
  }

  if (value === null || typeof value !== "object") return { ok: true };

  // A cycle is not itself a violation here; it is cut so traversal terminates.
  if (seen.has(value)) return { ok: true };
  seen.add(value);

  // Same reason as the byte check: a 200,000-entry Map has no own enumerable
  // properties, so the depth, width and string caps all saw an empty object and
  // waved it through. Rendered at the same depth, because a Map and the object
  // standing in for it occupy one level between them.
  const exotic = renderExotic(value);
  if (exotic !== undefined) return checkStructure(exotic.value, limits, depth, seen);

  const entries = Array.isArray(value) ? value : Object.values(value);
  const width = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (width > limits.maxKeys) return { ok: false, reason: "max_keys_exceeded" };

  for (const child of entries) {
    const result = checkStructure(child, limits, depth + 1, seen);
    if (!result.ok) return result;
  }
  return { ok: true };
}
