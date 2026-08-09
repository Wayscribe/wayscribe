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
