import { describe, expect, it } from "vitest";
import { normaliseHost, resolveReplayUrl, type PolicyResult } from "./url-policy.js";

const ALLOWED = ["localhost", "host.docker.internal", "demo-integration"];

const resolve = (base: string, path: string): PolicyResult => resolveReplayUrl(base, path, ALLOWED);

describe("resolveReplayUrl", () => {
  it("builds a URL from an allowed destination and a path", () => {
    const result = resolve("http://demo-integration:3200", "/replay/customer");
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.url.toString()).toBe("http://demo-integration:3200/replay/customer");
  });

  it("accepts a path without a leading slash", () => {
    const result = resolve("http://localhost:3200", "replay/customer");
    expect(result.ok && result.url.pathname).toBe("/replay/customer");
  });

  it("ignores a path on the base URL rather than appending to it", () => {
    // ADR-019: the destination contributes an origin. A base path that silently
    // prefixed the request path would make the stored path a half-truth.
    const result = resolve("http://localhost:3200/api/v2", "/replay/customer");
    expect(result.ok && result.url.pathname).toBe("/replay/customer");
  });
});

describe("scheme", () => {
  it.each([
    ["file:///etc/passwd", "invalid_scheme"],
    ["gopher://localhost/", "invalid_scheme"],
    ["ftp://localhost/", "invalid_scheme"]
  ])("rejects %s", (base, reason) => {
    const result = resolveReplayUrl(base, "/x", ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("rejects a base URL that is not a URL", () => {
    const result = resolveReplayUrl("not a url", "/x", ALLOWED);
    expect(!result.ok && result.reason).toBe("invalid_base_url");
  });
});

describe("path escapes", () => {
  it.each([
    ["an absolute URL", "http://evil.example.com/steal"],
    ["a protocol-relative URL", "//evil.example.com/steal"],
    ["upward traversal", "/replay/../../etc/passwd"],
    ["encoded traversal", "/replay/%2e%2e%2f%2e%2e%2fetc"],
    ["a backslash", "/replay\\..\\..\\etc"],
    ["a bare scheme", "javascript:alert(1)"],
    ["broken percent-encoding", "/replay/%zz"]
  ])("rejects %s", (_label, path) => {
    // Each of these lets a caller reach an origin the destination never named.
    const result = resolve("http://localhost:3200", path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_path");
  });

  it("allows a path that merely contains dots", () => {
    // Without this, the traversal rule could be implemented as "reject any dot"
    // and still pass every case above.
    const result = resolve("http://localhost:3200", "/replay/v1.2/customer.json");
    expect(result.ok).toBe(true);
  });

  it("allows a query string", () => {
    const result = resolve("http://localhost:3200", "/replay?dry=true");
    expect(result.ok).toBe(true);
  });
});

describe("host allowlist", () => {
  it("rejects a host that is not listed", () => {
    const result = resolve("http://evil.example.com", "/x");
    expect(!result.ok && result.reason).toBe("host_not_allowed");
  });

  it("names the variable to change in the message", () => {
    const result = resolve("http://evil.example.com", "/x");
    expect(!result.ok && result.message).toContain("REPLAY_ALLOWED_HOSTS");
  });

  it("compares case-insensitively", () => {
    expect(resolve("http://LOCALHOST:3200", "/x").ok).toBe(true);
  });

  it("rejects a subdomain of an allowed host", () => {
    // Allowlist entries are exact. `evil.localhost` resolving wherever an
    // attacker points it must not inherit `localhost`'s permission.
    const result = resolve("http://evil.localhost:3200", "/x");
    expect(!result.ok && result.reason).toBe("host_not_allowed");
  });
});

describe("normaliseHost", () => {
  it("collapses an IPv4-mapped IPv6 address", () => {
    // A rule written for 127.0.0.1 must also cover ::ffff:127.0.0.1, which is
    // the same address wearing a different notation.
    expect(normaliseHost("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normaliseHost("[::ffff:127.0.0.1]")).toBe("127.0.0.1");
  });

  it("leaves a real IPv6 address alone", () => {
    expect(normaliseHost("[::1]")).toBe("::1");
  });

  it("lowercases and trims", () => {
    expect(normaliseHost("  LocalHost ")).toBe("localhost");
  });
});
