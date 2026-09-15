/**
 * The one key a parsed record loses, restored after parsing.
 *
 * `JSON.parse` makes `__proto__` an ordinary own enumerable key, so any HTTP
 * body can carry one, and every popular JSON encoder writes one back. Zod's
 * `z.record` builds its output by assigning parsed keys onto a fresh object,
 * and an assignment to `__proto__` is spent on the prototype rather than stored,
 * so the key vanished from `aliases` and from `metadata`. `input` and `output`
 * never lost theirs, being `z.unknown()`, which is why this was invisible for so
 * long: the payload a reader looks at kept the key and the alias map did not.
 *
 * Measured on Zod 4.6.4, the loss is worse than it looks: `z.record` does not
 * validate the value under `__proto__` either. `{"__proto__": {"nested": true}}`
 * in `aliases` parsed successfully, which means restoring the raw value blindly
 * would put a value the schema refuses into a field the rest of ingestion
 * expects to be a string. So the value is validated here against the record's
 * own value schema, and an event that fails is refused as any other malformed
 * event is.
 *
 * `packages/payload-security/src/redact.ts` solves the same problem for the
 * walks it owns, with `defineKey`. This is the parser's half.
 */

/** Whether the object carries `__proto__` as its own key, and what it holds. */
export function ownProtoKey(value: unknown): { present: boolean; value: unknown } {
  if (typeof value !== "object" || value === null) return { present: false, value: undefined };
  if (!Object.hasOwn(value, PROTO_KEY)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, PROTO_KEY);
  // A getter would run host code here, and a body that came from JSON.parse
  // never has one. Anything but a plain data property is treated as absent.
  if (descriptor === undefined || !("value" in descriptor)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

/**
 * Write `__proto__` onto a rebuilt object as an ordinary own key.
 *
 * `Object.defineProperty` rather than assignment, because assignment is what
 * loses it; the property is made writable, enumerable and configurable so it
 * behaves exactly like every other key of the record, including under
 * `JSON.stringify`, `Object.entries` and a spread.
 */
export function defineProtoKey(target: object, value: unknown): void {
  Object.defineProperty(target, PROTO_KEY, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

const PROTO_KEY = "__proto__";
