import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import config from "../../next.config";
import { withContentSecurityPolicy } from "../../middleware";
import { contentSecurityPolicy, STATIC_SECURITY_HEADERS } from "./security-headers";

const directives = (policy: string): Map<string, string> =>
  new Map(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const [name = "", ...values] = part.split(/\s+/);
        return [name, values.join(" ")];
      })
  );

describe("contentSecurityPolicy", () => {
  it("allows only this origin, and scripts only by nonce", () => {
    const policy = directives(contentSecurityPolicy("bm9uY2U=", false));

    expect(policy.get("default-src")).toBe("'self'");
    expect(policy.get("script-src")).toBe("'self' 'nonce-bm9uY2U='");
    expect(policy.get("style-src")).toBe("'self'");
    expect(policy.get("frame-ancestors")).toBe("'none'");
    expect(policy.get("base-uri")).toBe("'self'");
    expect(policy.get("form-action")).toBe("'self'");
    expect(policy.get("object-src")).toBe("'none'");
    expect(contentSecurityPolicy("bm9uY2U=", false)).not.toMatch(/unsafe-(inline|eval)/);
  });

  it("adds 'unsafe-eval' in development only, which React's dev build needs", () => {
    expect(directives(contentSecurityPolicy("n", true)).get("script-src")).toBe(
      "'self' 'nonce-n' 'unsafe-eval'"
    );
  });
});

describe("the middleware", () => {
  const request = (): NextRequest => new NextRequest("http://localhost:3000/journeys/jrn_1");

  it("sends the policy, and hands the same policy to Next so its scripts carry the nonce", () => {
    const response = withContentSecurityPolicy(request(), false);
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{16,}'/);
    // NextResponse.next({ request: { headers } }) overrides request headers
    // through these, which is how the page render sees the nonce.
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(response.headers.get("x-middleware-override-headers")).toContain(
      "content-security-policy"
    );
  });

  it("uses a new nonce for every response", () => {
    const first = withContentSecurityPolicy(request(), false).headers.get(
      "content-security-policy"
    );
    const second = withContentSecurityPolicy(request(), false).headers.get(
      "content-security-policy"
    );
    expect(first).not.toBe(second);
  });
});

describe("next.config", () => {
  it("does not advertise the framework", () => {
    expect(config.poweredByHeader).toBe(false);
  });

  it("sends the static security headers on every route", async () => {
    const rules = (await config.headers?.()) ?? [];
    const everyRoute = rules.find((rule) => rule.source === "/:path*");
    expect(everyRoute?.headers).toEqual(STATIC_SECURITY_HEADERS);
    expect(Object.fromEntries(STATIC_SECURITY_HEADERS.map((h) => [h.key, h.value]))).toEqual({
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
  });
});
