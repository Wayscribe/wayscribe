import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "./redact.js";

describe("redact", () => {
  it("redacts a literal path", () => {
    expect(redact({ customer: { ssn: "111-22-3333", name: "Jorge" } }, ["customer.ssn"])).toEqual({
      customer: { ssn: REDACTED, name: "Jorge" }
    });
  });

  it("redacts a single-level wildcard", () => {
    expect(redact({ a: { password: "x" }, b: { password: "y" } }, ["*.password"])).toEqual({
      a: { password: REDACTED },
      b: { password: REDACTED }
    });
  });

  it("redacts array elements", () => {
    expect(
      redact({ items: [{ cardNumber: "4111" }, { cardNumber: "5222" }] }, ["items[*].cardNumber"])
    ).toEqual({
      items: [{ cardNumber: REDACTED }, { cardNumber: REDACTED }]
    });
  });

  it("matches header-like names case-insensitively", () => {
    expect(redact({ Authorization: "Bearer x" }, ["authorization"])).toEqual({
      Authorization: REDACTED
    });
  });

  it("preserves evidence that a value existed", () => {
    // SECURITY.md section 4: replace, never delete.
    const result = redact({ token: "secret" }, ["token"]) as Record<string, unknown>;
    expect("token" in result).toBe(true);
    expect(result["token"]).toBe(REDACTED);
  });

  it("leaves non-matching paths untouched", () => {
    expect(redact({ a: 1, b: "keep" }, ["c.d"])).toEqual({ a: 1, b: "keep" });
  });

  it("does not mutate its input", () => {
    const input = { customer: { ssn: "111-22-3333" } };
    redact(input, ["customer.ssn"]);
    expect(input.customer.ssn).toBe("111-22-3333");
  });

  it("redacts deeply nested secrets", () => {
    expect(redact({ a: { b: { c: { password: "x" } } } }, ["a.b.c.password"])).toEqual({
      a: { b: { c: { password: REDACTED } } }
    });
  });

  it("handles cyclic structures without hanging", () => {
    const input: Record<string, unknown> = { token: "secret" };
    input["self"] = input;
    const result = redact(input, ["token"]) as Record<string, unknown>;
    expect(result["token"]).toBe(REDACTED);
    expect(result["self"]).toBe("[CIRCULAR]");
  });

  it("passes primitives through", () => {
    expect(redact("plain", ["a"])).toBe("plain");
    expect(redact(null, ["a"])).toBe(null);
  });
});

describe("keys caught at any depth", () => {
  const SECRET = "Bearer sk_live_LEAKED";

  it("redacts the key however deep it sits", () => {
    // The defect this form exists for. `authorization` matched depth one and
    // `*.authorization` matched depth two, so `config.headers.authorization` —
    // the shape every axios error carries — was stored in the clear.
    expect(
      redact({ config: { headers: { authorization: SECRET } } }, ["**.authorization"])
    ).toEqual({ config: { headers: { authorization: REDACTED } } });
    expect(redact({ a: { b: { c: { d: { password: "x" } } } } }, ["**.password"])).toEqual({
      a: { b: { c: { d: { password: REDACTED } } } }
    });
  });

  it("redacts inside an array that has no configured array path", () => {
    // Worse than depth: an array was a hard stop. Without a matching `x[*]`
    // path the elements were walked with no paths at all, so nothing inside an
    // array was ever redacted by the built-in list.
    expect(redact({ items: [{ api_key: "ak_1" }, { api_key: "ak_2" }] }, ["**.api_key"])).toEqual({
      items: [{ api_key: REDACTED }, { api_key: REDACTED }]
    });
  });

  it("redacts through a mix of arrays and objects", () => {
    expect(redact({ batch: [{ req: { headers: { cookie: "sid=1" } } }] }, ["**.cookie"])).toEqual({
      batch: [{ req: { headers: { cookie: REDACTED } } }]
    });
  });

  it("matches case-insensitively at depth", () => {
    expect(
      redact({ config: { headers: { Authorization: SECRET } } }, ["**.authorization"])
    ).toEqual({ config: { headers: { Authorization: REDACTED } } });
  });

  it("redacts the whole value when the key holds a structure", () => {
    expect(
      redact({ a: { credentials: { user: "dana", password: "x" } } }, ["**.credentials"])
    ).toEqual({ a: { credentials: REDACTED } });
  });

  it("still redacts inside whatever toJSON returns", () => {
    // A custom toJSON must not become a way to smuggle a secret past a rule
    // that applies everywhere.
    const holder = { toJSON: () => ({ nested: { password: "hunter2" } }) };
    const value = JSON.stringify(redact({ account: holder }, ["**.password"]));
    expect(value).not.toContain("hunter2");
    expect(value).toContain(REDACTED);
  });

  it("preserves evidence that the value existed", () => {
    const result = redact({ a: { token: "x" } }, ["**.token"]) as {
      a: Record<string, unknown>;
    };
    expect("token" in result.a).toBe(true);
    expect(result.a["token"]).toBe(REDACTED);
  });

  it("leaves a bare name matching only at the top level", () => {
    // Control: the existing grammar must not silently widen. Someone who wrote
    // `id` to mask one top-level field must not find every id in the payload
    // masked after this change.
    expect(redact({ id: "top", nested: { id: "deep" } }, ["id"])).toEqual({
      id: REDACTED,
      nested: { id: "deep" }
    });
  });

  it("leaves a single wildcard matching only at depth two", () => {
    // The other half of that control.
    expect(redact({ a: { pin: "1" }, b: { c: { pin: "2" } } }, ["*.pin"])).toEqual({
      a: { pin: REDACTED },
      b: { c: { pin: "2" } }
    });
  });

  it("leaves keys that are not configured untouched at every depth", () => {
    // The control that a rule matching everything would fail.
    expect(redact({ a: { b: { name: "Jorge", note: "keep" } } }, ["**.password"])).toEqual({
      a: { b: { name: "Jorge", note: "keep" } }
    });
  });

  it("does not treat an unsupported ** form as matching everything", () => {
    // Only `**.<name>` is supported. `**.a.b` and `**.*` are not, and must fail
    // closed to matching nothing rather than open to matching anything.
    for (const path of ["**.a.b", "**.*", "**.a[*]", "**."]) {
      expect(redact({ a: { b: "keep" } }, [path])).toEqual({ a: { b: "keep" } });
    }
  });

  it("still finds a cycle underneath an any-depth rule", () => {
    const node: Record<string, unknown> = { password: "x" };
    node["self"] = node;
    const result = redact(node, ["**.password"]) as Record<string, unknown>;
    expect(result["password"]).toBe(REDACTED);
    expect(result["self"]).toBe("[CIRCULAR]");
  });
});

describe("names written in a different convention", () => {
  it("matches a secret however it is cased or separated", () => {
    // Half of JavaScript writes `apiKey` and half writes `api_key`. The list
    // held the snake_case spellings, matched them exactly, and stored the
    // camelCase ones in the clear — which is most of what a JavaScript payload
    // actually contains.
    for (const key of ["apiKey", "api_key", "api-key", "APIKey", "ApiKey"]) {
      expect(JSON.stringify(redact({ a: { [key]: "SECRET" } }, ["**.api_key"]))).not.toContain(
        "SECRET"
      );
    }
  });

  it("matches whichever spelling the rule itself uses", () => {
    // Normalisation is symmetric: an operator who writes the rule in camelCase
    // gets the same reach as one who writes it in snake_case.
    expect(JSON.stringify(redact({ a: { access_token: "SECRET" } }, ["**.accessToken"]))).toContain(
      REDACTED
    );
  });

  it("normalises scoped paths too", () => {
    expect(redact({ customer: { taxId: "111-22-3333" } }, ["customer.tax_id"])).toEqual({
      customer: { taxId: REDACTED }
    });
  });

  it("does not merge names that merely look similar", () => {
    // The control. Normalisation removes separators and case; it must not make
    // `secret` match `secretary` or `apiKey` match `api`.
    const payload = { a: { secretary: "Dana", api: "v2", tokenizer: "bpe" } };
    expect(redact(payload, ["**.secret", "**.api_key", "**.token"])).toEqual(payload);
  });
});

describe("redaction reaches inside values that hide their contents", () => {
  const SECRET = "Bearer sk_live_LEAKED";
  const text = (value: unknown, paths: readonly string[]): string =>
    JSON.stringify(redact(value, paths));

  /**
   * Every `not.toContain(secret)` below is paired with a contents assertion.
   * On its own each would pass vacuously, because these values stored as `{}`
   * and an empty object contains no secret either. The contents half is the one
   * that fails before the change; do not delete it as redundant.
   */

  it("redacts inside a Map used as a header bag", () => {
    const headers = new Map([
      ["authorization", SECRET],
      ["x-request-id", "req_123"]
    ]);
    const stored = text({ headers }, ["**.authorization"]);
    expect(stored).toContain("req_123");
    expect(stored).not.toContain(SECRET);
  });

  it("redacts inside a Set", () => {
    const stored = text({ sessions: new Set([{ password: "hunter2", user: "dana" }]) }, [
      "**.password"
    ]);
    expect(stored).toContain("dana");
    expect(stored).not.toContain("hunter2");
  });

  it("redacts inside an error's request config", () => {
    const failure = Object.assign(new Error("Request failed with status code 401"), {
      config: { url: "https://api.stripe.com/v1/charges", headers: { authorization: SECRET } }
    });
    const stored = text({ failure }, ["**.authorization"]);
    expect(stored).toContain("api.stripe.com");
    expect(stored).toContain("status code 401");
    expect(stored).not.toContain(SECRET);
  });

  it("redacts down a chain of causes", () => {
    const inner = Object.assign(new Error("upstream"), { headers: { authorization: SECRET } });
    const stored = text({ failure: new Error("sync failed", { cause: inner }) }, [
      "**.authorization"
    ]);
    expect(stored).toContain("upstream");
    expect(stored).not.toContain(SECRET);
  });

  it("addresses a Map entry by the path it is stored under", () => {
    // The property that makes a wrapper frame unacceptable: an operator reads
    // `headers.authorization` out of a stored payload and writes exactly that
    // rule. If the render nested the entries under a frame, the rule that looks
    // right would match nothing and the secret would keep flowing.
    const value = { headers: new Map([["authorization", SECRET]]) };
    expect(text(value, ["headers.authorization"])).toBe(
      '{"headers":{"authorization":"[REDACTED]"}}'
    );
  });

  it("replaces a whole container matched by name without rendering it", () => {
    expect(text({ secret: new Map([["a", 1]]) }, ["**.secret"])).toBe('{"secret":"[REDACTED]"}');
  });

  it("reaches a secret in a Map inside a Map", () => {
    const inner = new Map([["password", "hunter2"]]);
    const stored = text({ a: new Map([["b", inner]]) }, ["a.b.password"]);
    expect(stored).toBe('{"a":{"b":{"password":"[REDACTED]"}}}');
  });

  it("marks a cycle through a Map and still redacts its siblings", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["bag"] = new Map<string, unknown>([
      ["parent", node],
      ["password", "hunter2"]
    ]);
    const stored = text(node, ["**.password"]);
    expect(stored).toContain("[CIRCULAR]");
    expect(stored).not.toContain("hunter2");
  });

  it("expands the same Map under two sibling keys", () => {
    // The control against over-eager cycle detection: a shared reference is not
    // a loop, and reporting the second as [CIRCULAR] would show the diff a
    // change to a field that did not change.
    const shared = new Map([["city", "Durham"]]);
    expect(redact({ billing: shared, shipping: shared }, ["nothing"])).toEqual({
      billing: { city: "Durham" },
      shipping: { city: "Durham" }
    });
  });

  it("leaves a plain object's rebuild exactly as it was", () => {
    // The control that a renderer firing too broadly would fail.
    const payload = { customer: { name: "Jorge" }, items: [{ sku: "A-1" }] };
    expect(redact(payload, ["nothing"])).toEqual(payload);
  });
});

describe("a payload with a __proto__ key", () => {
  /**
   * `JSON.parse` makes `__proto__` an ordinary own enumerable key, so any
   * webhook body can carry one. Rebuilding with `result[key] = child` then
   * spends it on the object's prototype instead of storing it: the field
   * vanished from the recorded payload entirely, which for a tool whose whole
   * promise is showing what the payload was is the promise broken.
   */
  const parsed = (): Record<string, unknown> =>
    JSON.parse('{"__proto__":{"injected":1},"keep":2}') as Record<string, unknown>;

  it("keeps the field instead of silently dropping it", () => {
    const result = redact(parsed(), ["nothing"]) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["__proto__", "keep"]);
    expect(result["keep"]).toBe(2);
  });

  it("leaves the result an ordinary object", () => {
    const result = redact(parsed(), ["nothing"]) as object;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["injected"]).toBeUndefined();
  });

  it("survives serialization, which is what storage does", () => {
    // Asserted on the JSON text, not against an object literal: `__proto__` in
    // a literal sets the prototype rather than creating a key, so `toEqual`
    // against one compares nothing and passes either way.
    const round = JSON.stringify(redact(parsed(), ["nothing"]));
    expect(round).toBe('{"__proto__":{"injected":1},"keep":2}');
  });

  it("still redacts underneath it", () => {
    // The control: preserving the key must not create a place secrets hide.
    // Both halves matter — the first fails today because the field is gone.
    const payload = JSON.parse('{"__proto__":{"password":"hunter2"}}') as Record<string, unknown>;
    const stored = JSON.stringify(redact(payload, ["**.password"]));
    expect(stored).toContain("__proto__");
    expect(stored).not.toContain("hunter2");
  });
});

describe("values that serialize themselves", () => {
  /**
   * The object rebuild that makes redaction possible also destroyed anything
   * whose meaning lives on its prototype. A `Date` has no own enumerable
   * properties, so it became `{}` — and because this happens inside the host
   * process, before the wire, the diff then reported "No fields changed" for a
   * step that moved a timestamp by a year.
   */
  it("keeps a Date", () => {
    const value = redact({ expiresAt: new Date("2026-01-01T00:00:00.000Z") }, ["secret"]);
    expect(JSON.stringify(value)).toBe('{"expiresAt":"2026-01-01T00:00:00.000Z"}');
  });

  it("lets two different Dates still differ", () => {
    // The property that actually matters: the diff has to be able to see it.
    const before = redact({ at: new Date("2026-01-01T00:00:00.000Z") }, ["secret"]);
    const after = redact({ at: new Date("2027-01-01T00:00:00.000Z") }, ["secret"]);
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });

  it("keeps a Buffer's own representation", () => {
    const value = redact({ blob: Buffer.from("hi") }, ["secret"]);
    expect(JSON.stringify(value)).toContain("Buffer");
  });

  it("still redacts inside whatever toJSON returns", () => {
    // A custom toJSON must not become a way to smuggle a secret past redaction.
    const holder = { toJSON: () => ({ password: "hunter2", user: "dana" }) };
    const value = redact({ account: holder }, ["account.password"]);
    expect(JSON.stringify(value)).toContain("[REDACTED]");
    expect(JSON.stringify(value)).not.toContain("hunter2");
    expect(JSON.stringify(value)).toContain("dana");
  });

  it("survives a toJSON that throws", () => {
    const holder = {
      toJSON: () => {
        throw new Error("nope");
      }
    };
    expect(() => redact({ account: holder }, ["secret"])).not.toThrow();
  });
});

describe("shared references are not cycles", () => {
  it("keeps a sibling reference intact", () => {
    // Two fields pointing at one address object is ordinary. Reporting the
    // second as [CIRCULAR] is a phantom change on a field that did not change.
    const address = { city: "Durham" };
    const value = redact({ billing: address, shipping: address }, ["secret"]);
    expect(value).toEqual({ billing: { city: "Durham" }, shipping: { city: "Durham" } });
  });

  it("keeps a repeated element in an array", () => {
    const line = { sku: "A" };
    expect(redact({ lines: [line, line] }, ["secret"])).toEqual({
      lines: [{ sku: "A" }, { sku: "A" }]
    });
  });

  it("still catches a real cycle", () => {
    // The control. Without it, deleting cycle detection entirely would pass
    // both tests above and then hang on a self-referential object.
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;
    expect(JSON.stringify(redact(node, ["secret"]))).toContain("[CIRCULAR]");
  });

  it("still catches a cycle through an array", () => {
    const list: unknown[] = [];
    list.push(list);
    expect(JSON.stringify(redact({ list }, ["secret"]))).toContain("[CIRCULAR]");
  });
});
