import { describe, expect, it } from "vitest";
import { applyCapture } from "./capture.js";
import { REDACTED } from "./redact.js";

const payload = {
  authorization: "Bearer secret",
  customer: { name: "Jorge", ssn: "111-22-3333" },
  phone: "+1 919 555 1234"
};

describe("applyCapture", () => {
  it("drops payloads entirely in metadata-only mode", () => {
    expect(applyCapture(payload, { mode: "metadata-only" })).toBeUndefined();
  });

  it("keeps only allowlisted paths in allowlisted-fields mode", () => {
    const result = applyCapture(payload, {
      mode: "allowlisted-fields",
      allowlist: ["phone"]
    });
    expect(result).toEqual({ phone: "+1 919 555 1234" });
  });

  it("redacts configured paths in redacted-payload mode", () => {
    const result = applyCapture(payload, {
      mode: "redacted-payload",
      redactionPaths: ["customer.ssn"]
    }) as Record<string, unknown>;
    const customer = result["customer"] as Record<string, unknown>;
    expect(customer["ssn"]).toBe(REDACTED);
    expect(customer["name"]).toBe("Jorge");
  });

  it("still redacts built-in secrets under full-payload", () => {
    // SECURITY.md section 3: full-payload must never mean skip secret detection.
    const result = applyCapture(payload, { mode: "full-payload" }) as Record<string, unknown>;
    expect(result["authorization"]).toBe(REDACTED);
    expect(result["phone"]).toBe("+1 919 555 1234");
  });

  it("applies built-in secrets in every payload-bearing mode", () => {
    for (const mode of ["redacted-payload", "full-payload"] as const) {
      const result = applyCapture(payload, { mode }) as Record<string, unknown>;
      expect(result["authorization"]).toBe(REDACTED);
    }
  });

  it("returns undefined for an undefined payload", () => {
    expect(applyCapture(undefined, { mode: "full-payload" })).toBeUndefined();
  });

  it("keeps nested allowlisted paths", () => {
    const result = applyCapture(payload, {
      mode: "allowlisted-fields",
      allowlist: ["customer.name"]
    });
    expect(result).toEqual({ customer: { name: "Jorge" } });
  });

  it("returns an empty object when nothing is allowlisted", () => {
    expect(applyCapture(payload, { mode: "allowlisted-fields", allowlist: [] })).toEqual({});
  });
});
