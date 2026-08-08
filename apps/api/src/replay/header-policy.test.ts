import { describe, expect, it } from "vitest";
import { BLOCKED_HEADER_NAMES, applyHeaderPolicy } from "./header-policy.js";

describe("applyHeaderPolicy", () => {
  it("strips every header SECURITY.md section 8 names", () => {
    const requested = Object.fromEntries(
      BLOCKED_HEADER_NAMES.map((name) => [name, "secret-value"])
    );
    const { headers, blocked } = applyHeaderPolicy(requested, undefined);

    expect(blocked.sort()).toEqual([...BLOCKED_HEADER_NAMES].sort());
    expect(JSON.stringify(headers)).not.toContain("secret-value");
  });

  it("covers the three the payload redaction list omits", () => {
    // Reusing DEFAULT_SECRET_PATHS would have looked right and let these pass.
    expect(BLOCKED_HEADER_NAMES).toContain("x-amz-security-token");
    expect(BLOCKED_HEADER_NAMES).toContain("x-hook-signature");
    expect(BLOCKED_HEADER_NAMES).toContain("stripe-signature");
  });

  it("matches case-insensitively", () => {
    const { headers, blocked } = applyHeaderPolicy(
      { Authorization: "Bearer real-token", "X-API-Key": "k" },
      undefined
    );
    expect(blocked).toContain("authorization");
    expect(blocked).toContain("x-api-key");
    expect(JSON.stringify(headers)).not.toContain("real-token");
  });

  it("keeps a safe header", () => {
    const { headers } = applyHeaderPolicy({ accept: "application/json" }, undefined);
    expect(headers["accept"]).toBe("application/json");
  });

  it("drops a value carrying a newline", () => {
    // A CR or LF in a value splits the request into two.
    const { headers, blocked } = applyHeaderPolicy(
      { "x-note": "fine\r\nx-injected: evil" },
      undefined
    );
    expect(blocked).toContain("x-note");
    expect(headers["x-injected"]).toBeUndefined();
  });

  it("lets a destination's configured credential through", () => {
    // SECURITY.md section 8 allows a destination-specific test secret. It is
    // configured by an operator rather than replayed from a recorded request.
    const { headers } = applyHeaderPolicy(
      { authorization: "Bearer recorded-production-token" },
      { authorization: "Bearer configured-development-token" }
    );
    expect(headers["authorization"]).toBe("Bearer configured-development-token");
    expect(JSON.stringify(headers)).not.toContain("recorded-production-token");
  });

  it("identifies itself and says the request is a replay", () => {
    const { headers } = applyHeaderPolicy({ "user-agent": "curl/8" }, undefined);
    expect(headers["user-agent"]).toBe("flight-recorder-replay");
    expect(headers["x-flight-replay"]).toBe("true");
  });

  it("defaults the content type but respects an explicit one", () => {
    expect(applyHeaderPolicy(undefined, undefined).headers["content-type"]).toBe(
      "application/json"
    );
    expect(
      applyHeaderPolicy({ "content-type": "text/plain" }, undefined).headers["content-type"]
    ).toBe("text/plain");
  });
});
