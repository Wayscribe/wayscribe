import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { COLLIDED_KEYS, renderExotic } from "./exotic.js";

const rendered = (value: object): unknown => renderExotic(value)?.value;

describe("renderExotic", () => {
  it("renders a Map as an object under the keys the data already had", () => {
    // No wrapper frame: the path a reader sees in a stored payload has to be
    // the path a redaction rule can be written against.
    expect(rendered(new Map([["authorization", "Bearer x"]]))).toEqual({
      authorization: "Bearer x"
    });
  });

  it("renders a Set as an array", () => {
    expect(rendered(new Set([1, "two"]))).toEqual([1, "two"]);
  });

  it("renders an Error with the two fields a rebuild loses", () => {
    // name and message live on the prototype or non-enumerable, so an Error
    // rebuilt from own enumerable properties says nothing about what failed.
    const failure = Object.assign(new Error("Request failed"), { status: 401 });
    expect(rendered(failure)).toEqual({ name: "Error", message: "Request failed", status: 401 });
  });

  it("omits an error's stack", () => {
    expect(Object.keys(rendered(new Error("x")) as object)).not.toContain("stack");
  });

  it("keeps an error's cause as a reference for the caller to walk", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    expect((rendered(outer) as { cause: unknown }).cause).toBe(inner);
  });

  it("keeps an AggregateError's errors", () => {
    // `errors` is an own accessor that hands back a fresh array, so the list is
    // a copy. Its elements are the originals, which is what the walk needs.
    const parts = [new Error("a")];
    const errors = (rendered(new AggregateError(parts, "all failed")) as { errors: unknown[] })
      .errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(parts[0]);
  });

  it("renders a RegExp as the literal a reader recognises", () => {
    expect(rendered(/secret-(\d+)/gi)).toBe("/secret-(\\d+)/gi");
  });

  it("renders a Headers bag and a URLSearchParams", () => {
    expect(rendered(new Headers({ authorization: "Bearer x" }))).toEqual({
      authorization: "Bearer x"
    });
    expect(rendered(new URLSearchParams("a=1&b=2"))).toEqual({ a: "1", b: "2" });
  });

  it("leaves ordinary values alone", () => {
    // The control: a renderer that fired on everything would pass the tests
    // above and destroy every plain object in the process.
    for (const value of [{ a: 1 }, [1, 2], new Date(), Buffer.from("x")]) {
      expect(renderExotic(value)).toBeUndefined();
    }
  });
});

describe("the render stays shallow", () => {
  it("hands back the original references rather than converting them", () => {
    // The invariant the whole design rests on. A deep conversion would carry
    // the subtree past every remaining match site and past the ancestor set
    // that catches cycles, turning this from a fix into a leak.
    const inner = new Map([["password", "hunter2"]]);
    expect((rendered(new Map([["nested", inner]])) as { nested: unknown }).nested).toBe(inner);

    const element = { password: "hunter2" };
    expect((rendered(new Set([element])) as unknown[])[0]).toBe(element);
  });

  it("does not recurse into a self-referential Map", () => {
    // Terminates because it never descends; the caller's ancestor set is what
    // turns this into a marker.
    const loop = new Map<string, unknown>();
    loop.set("self", loop);
    expect((rendered(loop) as { self: unknown }).self).toBe(loop);
  });
});

describe("keys that cannot survive intact", () => {
  it("reports how many values a key collision cost", () => {
    // `1` and `"1"` are different Map keys and the same object key. Silently
    // overwriting one is the class of loss this change exists to remove.
    const collided = new Map<unknown, unknown>([
      [1, "first"],
      ["1", "second"]
    ]);
    expect(rendered(collided)).toEqual({ "1": "second", [COLLIDED_KEYS]: 1 });
  });

  it("counts two object keys as one collision", () => {
    const byObject = new Map<unknown, unknown>([
      [{ tenant: 1 }, "a"],
      [{ tenant: 2 }, "b"]
    ]);
    expect(rendered(byObject)).toEqual({ "[object]": "b", [COLLIDED_KEYS]: 1 });
  });

  it("leaves the marker off when nothing collided", () => {
    // The control for the two above.
    expect(rendered(new Map([["a", 1]]))).toEqual({ a: 1 });
  });

  it("keeps the application's own value when it uses the marker name", () => {
    const clash = new Map<unknown, unknown>([
      [COLLIDED_KEYS, "mine"],
      [1, "first"],
      ["1", "second"]
    ]);
    expect((rendered(clash) as Record<string, unknown>)[COLLIDED_KEYS]).toBe("mine");
  });

  it("keeps a Map entry keyed __proto__ instead of spending it on the prototype", () => {
    const proto = new Map([["__proto__", { injected: 1 }]]);
    const result = rendered(proto) as object;
    expect(Object.keys(result)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

describe("detection cannot be forged or defeated", () => {
  it("ignores an object claiming to be a Set", () => {
    // `Symbol.toStringTag` is writable by anyone. If the tag alone decided,
    // this object's fields would be replaced by a positional array — silently
    // dropping both the data and any rule written against `token`.
    const liar = { token: "T", note: "keep", [Symbol.toStringTag]: "Set" };
    expect(renderExotic(liar)).toBeUndefined();
  });

  it("ignores an object claiming to be a Map, Headers, or a RegExp", () => {
    for (const tag of ["Map", "Headers", "URLSearchParams", "RegExp"]) {
      expect(renderExotic({ a: 1, [Symbol.toStringTag]: tag })).toBeUndefined();
    }
  });

  it("cannot be made to lose data by claiming to be an Error", () => {
    // Error is the one branch with no unforgeable brand — the tag is what makes
    // a cross-realm error recognisable, and nothing else distinguishes one.
    // That is acceptable only because the Error rendering is non-destructive:
    // it copies own enumerable properties under their own names, so a forgery
    // produces the same fields the ordinary rebuild would, and any rule written
    // against them still matches.
    const liar = { token: "T", note: "keep", [Symbol.toStringTag]: "Error" };
    expect(renderExotic(liar)?.value).toEqual({ token: "T", note: "keep" });
  });

  it("renders values built in another realm", () => {
    // `instanceof` is realm-bound and would miss every one of these. A payload
    // crossing a vm, worker or iframe boundary is ordinary in Node.
    const foreign = runInNewContext(
      `({ map: new Map([["authorization", "Bearer x"]]), set: new Set([1]), re: /x/g, err: new Error("boom") })`
    ) as Record<string, object>;

    expect(rendered(foreign["map"] as object)).toEqual({ authorization: "Bearer x" });
    expect(rendered(foreign["set"] as object)).toEqual([1]);
    expect(rendered(foreign["re"] as object)).toBe("/x/g");
    expect((rendered(foreign["err"] as object) as { message: string }).message).toBe("boom");
  });

  it("survives a subclass whose iterator throws", () => {
    const hostile = new Map([["a", 1]]);
    Object.defineProperties(hostile, {
      entries: {
        value: () => {
          throw new Error("no");
        }
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error("no");
        }
      }
    });
    // Read through the intrinsic, so the overrides never run.
    expect(rendered(hostile)).toEqual({ a: 1 });
  });

  it("survives an error whose cause accessor throws", () => {
    const hostile = new Error("outer");
    Object.defineProperty(hostile, "cause", {
      get(): never {
        throw new Error("exploded");
      },
      enumerable: false,
      configurable: true
    });
    expect(() => renderExotic(hostile)).not.toThrow();
  });
});
