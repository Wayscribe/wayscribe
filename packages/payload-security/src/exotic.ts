/**
 * Values whose contents live somewhere `Object.entries` cannot see.
 *
 * A `Map`, a `Set`, an `Error`, a `RegExp` and a `Headers` all keep their data
 * in internal slots rather than in own enumerable properties, so the object
 * rebuild that makes redaction possible turned every one of them into `{}`. The
 * event was still recorded; the field was simply empty, and nothing said so.
 *
 * Each is rendered into a plain container instead. Two properties make that
 * safe, and both are load-bearing:
 *
 * 1. **Shallow.** A render never recurses. Its values are the *original*
 *    references, handed straight back to the walk that called it. Converting a
 *    whole subtree here would carry it past every remaining match site and past
 *    the ancestor set that detects cycles — which would turn this from a fix
 *    into a leak.
 * 2. **Plain.** A render emits ordinary objects and arrays under the keys the
 *    data already had, with no wrapper frame and no type marker. The path an
 *    operator reads out of a stored payload is therefore the path a redaction
 *    rule matches. A `{__type, entries}` wrapper would shift every key one
 *    level down, so `headers.authorization` in the UI would need a rule written
 *    against `headers.entries.authorization` — and the rule that looks right
 *    would silently match nothing.
 *
 * The cost is that a `Map` is indistinguishable from an object once stored, and
 * a `Set` from an array. That is deliberate: every shape that preserves the
 * distinction reintroduces the wrapper frame above.
 */

/** Reported when distinct keys collapse onto one name, so the loss is not silent. */
export const COLLIDED_KEYS = "[COLLIDED_KEYS]";

/**
 * A shallow plain rendering of `value`, or undefined if it needs none.
 *
 * Wrapped in a result object so a render that legitimately produces `undefined`
 * stays distinguishable from "nothing to do here".
 */
export function renderExotic(value: object): { value: unknown } | undefined {
  // The tag is a cheap filter, not the decision. It is spoofable through
  // `Symbol.toStringTag`, so every branch below confirms by reaching for the
  // intrinsic itself, which a forgery cannot satisfy. Both failure directions
  // land on today's behaviour rather than on something new.
  switch (Object.prototype.toString.call(value)) {
    case "[object Map]":
      return entryObject(value, MAP_ENTRIES);
    case "[object Headers]":
      return entryObject(value, HEADERS_ENTRIES);
    case "[object URLSearchParams]":
      return entryObject(value, PARAMS_ENTRIES);
    case "[object Set]":
      return setArray(value);
    case "[object Error]":
      return errorObject(value);
    case "[object RegExp]":
      return regExpText(value);
    default:
      return undefined;
  }
}

/**
 * `instanceof` is realm-bound: a value built in a `vm` context, another
 * `<iframe>`, or a worker fails it while being a genuine Map. Calling the
 * intrinsic method on the value works across realms and cannot be faked, since
 * it reads an internal slot no ordinary object has.
 */
/* eslint-disable @typescript-eslint/unbound-method --
   Detaching these is the point. Each is invoked with `.call(value)` so the
   internal slot is read from the candidate rather than from a method the
   candidate supplied, which is what makes the check both cross-realm and
   impossible to forge. */
const MAP_ENTRIES = Map.prototype.entries as (this: unknown) => Iterable<[unknown, unknown]>;
const HEADERS_ENTRIES = Headers.prototype.entries as (this: unknown) => Iterable<[string, string]>;
const PARAMS_ENTRIES = URLSearchParams.prototype.entries as (
  this: unknown
) => Iterable<[string, string]>;
const SET_VALUES = Set.prototype.values;
const REGEXP_TO_STRING = RegExp.prototype.toString;
// The brand check for a RegExp: unlike `toString`, the `source` getter throws
// on anything without the internal slot.
const REGEXP_SOURCE = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get as (
  this: unknown
) => string;
/* eslint-enable @typescript-eslint/unbound-method */

function entryObject(
  value: object,
  entries: (this: unknown) => Iterable<[unknown, unknown]>
): { value: unknown } | undefined {
  let pairs: Iterable<[unknown, unknown]>;
  try {
    pairs = entries.call(value);
  } catch {
    // Not what its tag claimed. Fall through to the ordinary rebuild.
    return undefined;
  }

  const result: Record<string, unknown> = {};
  let collisions = 0;
  try {
    for (const [key, entry] of pairs) {
      // A Map may be keyed by anything. Two distinct keys can therefore render
      // to one name — `1` and `"1"`, or two different objects, both of which
      // become the same string — and the second would quietly overwrite the
      // first. The count says how many values that cost.
      const name = typeof key === "string" ? key : safeString(key);
      if (Object.hasOwn(result, name)) collisions += 1;
      defineOwn(result, name, entry);
    }
  } catch {
    // A subclass with a throwing iterator. Keep whatever was read.
  }

  // Never overwrites: an application whose own data uses this name keeps it,
  // and the marker is dropped rather than the value.
  if (collisions > 0 && !Object.hasOwn(result, COLLIDED_KEYS)) {
    defineOwn(result, COLLIDED_KEYS, collisions);
  }
  return { value: result };
}

function setArray(value: object): { value: unknown } | undefined {
  try {
    return { value: [...SET_VALUES.call(value)] };
  } catch {
    return undefined;
  }
}

/**
 * `name` and `message` are on the prototype or non-enumerable, so an Error
 * rebuilt from its own enumerable properties keeps everything a library
 * attached to it and loses the two fields that say what went wrong.
 *
 * `stack` is deliberately excluded. It is the largest field on a typical error,
 * it repeats information the timeline already carries, and `EVENT_PROTOCOL.md`
 * gives thrown errors their own structured fields rather than a trace. An
 * error's own `toJSON` is honoured before this runs, so a library that chooses
 * to ship its stack still does.
 */
function errorObject(value: object): { value: unknown } | undefined {
  const error = value as Error & { cause?: unknown; errors?: unknown };
  const fields = error as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  read(() => {
    if (typeof error.name === "string") result["name"] = error.name;
  });
  read(() => {
    if (typeof error.message === "string") result["message"] = error.message;
  });

  // The valuable part in practice: an axios error's `config` and `response` are
  // assigned, so they are own and enumerable, and they are exactly what
  // somebody debugging a failed call needs to see. Read one at a time —
  // `Object.keys` invokes nothing, but reading a value invokes its getter, and
  // one that throws should cost its own field rather than all of them.
  read(() => {
    for (const key of Object.keys(fields)) {
      read(() => {
        defineOwn(result, key, fields[key]);
      });
    }
  });

  // Own-property checks, not `in`: an inherited `cause` belongs to some other
  // error. The value stays a reference, so a chain of causes is walked — and a
  // loop between two errors caught — by the caller rather than here.
  read(() => {
    if (Object.hasOwn(error, "cause")) defineOwn(result, "cause", error.cause);
  });
  read(() => {
    if (Object.hasOwn(error, "errors")) defineOwn(result, "errors", error.errors);
  });

  return { value: result };
}

/**
 * Reads one field, keeping the rest if it throws.
 *
 * An own accessor that throws is ordinary on a half-built object, and it must
 * cost that one field. Letting it escape would degrade the whole payload to
 * `[UNCAPTURABLE]` — losing an error's message because its `cause` getter
 * failed, on the step that was already going wrong.
 */
function read(gather: () => void): void {
  try {
    gather();
  } catch {
    // Intentionally empty: the field is simply absent.
  }
}

function regExpText(value: object): { value: unknown } | undefined {
  try {
    // The brand check has to be the `source` getter. `RegExp.prototype.toString`
    // is specified to work on any object — it reads `.source` and `.flags` as
    // ordinary properties — so an impostor came back as `/undefined/undefined`
    // instead of being rejected, replacing a real object's fields with a string.
    REGEXP_SOURCE.call(value);
    // Then the literal a reader recognises: /secret-(\d+)/gi
    return { value: REGEXP_TO_STRING.call(value) };
  } catch {
    return undefined;
  }
}

/** A key name for a non-string Map key, without running application code. */
function safeString(key: unknown): string {
  if (typeof key === "object" && key !== null) return "[object]";
  if (typeof key === "symbol") return key.toString();
  if (typeof key === "function") return "[function]";
  return String(key);
}

/**
 * `defineProperty` rather than assignment, for the same reason the redaction
 * walk uses it: a Map keyed by the string `__proto__` would otherwise set the
 * rendered object's prototype and lose the entry.
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
