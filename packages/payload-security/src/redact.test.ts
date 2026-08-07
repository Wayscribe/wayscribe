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
