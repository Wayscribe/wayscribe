import { describe, expect, it } from "vitest";
import { applyCapture, redactAlways, type CapturePolicy } from "./capture.js";
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

describe("the unredacted observer through capture", () => {
  const sentinel = "sentinel-value-7Qx";
  const secretish = {
    gatewayApiToken: sentinel,
    customer: { stripeWebhookSecret: sentinel, dbPassword2: sentinel },
    headers: [{ "x-auth-token": sentinel }],
    authorization: sentinel,
    phone: "+1 919 555 1234"
  };

  /** The paths reported, and what was stored, for one capture. */
  function observed(capture: (report: (name: string, path: string) => void) => unknown): {
    paths: string[];
    stored: string;
  } {
    const paths: string[] = [];
    const stored = capture((name, path) => {
      expect(`${name} ${path}`).not.toContain(sentinel);
      paths.push(path);
    });
    return { paths, stored: JSON.stringify(stored ?? null) };
  }

  it("reports what the payload modes store, and not what a rule covers", () => {
    for (const policy of [
      { mode: "redacted-payload" },
      { mode: "full-payload", allowFullPayload: true },
      { mode: "full-payload" }
    ] satisfies CapturePolicy[]) {
      const { paths, stored } = observed((report) => applyCapture(secretish, policy, report));
      expect(paths).toEqual([
        "gatewayApiToken",
        "customer.stripeWebhookSecret",
        "customer.dbPassword2",
        "headers[*].x-auth-token"
      ]);
      expect(stored).toContain(`"authorization":"[REDACTED]"`);
    }
    const covered = observed((report) =>
      applyCapture(
        secretish,
        { mode: "redacted-payload", redactionPaths: ["**.gateway_api_token", "customer.*"] },
        report
      )
    );
    expect(covered.paths).toEqual(["headers[*].x-auth-token"]);
  });

  it("reports only what an allowlist keeps, and nothing under metadata-only", () => {
    const allowlisted = observed((report) =>
      applyCapture(
        secretish,
        { mode: "allowlisted-fields", allowlist: ["customer.dbPassword2", "phone"] },
        report
      )
    );
    expect(allowlisted.paths).toEqual(["customer.dbPassword2"]);
    const none = observed((report) => applyCapture(secretish, { mode: "metadata-only" }, report));
    expect(none).toEqual({ paths: [], stored: "null" });
  });

  it("reports from redactAlways in every mode, since those fields survive every mode", () => {
    for (const mode of ["metadata-only", "allowlisted-fields", "redacted-payload"] as const) {
      const { paths } = observed((report) => redactAlways(secretish, { mode }, report));
      expect(paths).toContain("gatewayApiToken");
    }
  });
});
