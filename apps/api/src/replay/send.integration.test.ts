import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendReplay } from "./send.js";

/**
 * These run against a real socket rather than a mock. The properties being
 * tested — that a redirect is not followed, that a body is capped mid-stream,
 * that a timeout fires — are properties of the HTTP client, and a mock would
 * only test the mock.
 */
describe("sendReplay", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? "/";

      if (url === "/redirect") {
        response.writeHead(302, { location: "http://evil.example.com/stolen" });
        response.end();
        return;
      }
      if (url === "/huge") {
        response.writeHead(200, { "content-type": "text/plain" });
        // Far past the cap the test sets.
        response.end("x".repeat(200_000));
        return;
      }
      if (url === "/slow") {
        setTimeout(() => {
          response.writeHead(200);
          response.end("{}");
        }, 3_000);
        return;
      }
      if (url === "/html") {
        response.writeHead(500, { "content-type": "text/html" });
        response.end("<html>broken</html>");
        return;
      }

      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            received: JSON.parse(body || "null"),
            headers: request.headers,
            method: request.method
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const base = (): string => `http://localhost:${String(port)}`;
  const send = (path: string, extra: Record<string, unknown> = {}) =>
    sendReplay({
      baseUrl: base(),
      path,
      method: "POST",
      headers: { "content-type": "application/json" },
      payload: { externalId: "ACCT-1" },
      allowedHosts: ["localhost"],
      ...extra
    });

  it("sends the payload and returns the response", async () => {
    const result = await send("/replay/customer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.status).toBe(200);
    const body = result.body as { received: unknown; method: string };
    expect(body.received).toEqual({ externalId: "ACCT-1" });
    expect(body.method).toBe("POST");
  });

  it("sets a Host header matching the destination, not the dialled address", async () => {
    // The connection goes to a resolved address; the server still has to see
    // the name it is configured for, or virtual hosting breaks.
    const result = await send("/replay/customer");
    if (!result.ok) throw new Error("expected success");
    const body = result.body as { headers: Record<string, string> };
    expect(body.headers["host"]).toBe(`localhost:${String(port)}`);
  });

  it("does not follow a redirect", async () => {
    // The whole point: following one would reach a host the operator never
    // allowlisted, after every check had already passed.
    const result = await send("/redirect");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(302);
  });

  it("truncates an oversize response instead of buffering it", async () => {
    const result = await send("/huge", { maxResponseBytes: 1_024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.body).length).toBeLessThan(4_000);
  });

  it("times out on a slow destination and records the failure", async () => {
    const result = await send("/slow", { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked).toBe(false);
  });

  it("keeps a non-JSON body as text rather than discarding it", async () => {
    // A development endpoint returning an HTML error page is exactly what the
    // operator needs to read.
    const result = await send("/html");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(500);
      expect(String(result.body)).toContain("broken");
    }
  });

  it("refuses a host outside the allowlist before opening a socket", async () => {
    const result = await sendReplay({
      baseUrl: "http://evil.example.com",
      path: "/x",
      method: "POST",
      headers: {},
      payload: {},
      allowedHosts: ["localhost"]
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.blocked) expect(result.reason).toBe("host_not_allowed");
  });

  it("refuses an allowlisted name that resolves to the metadata endpoint", async () => {
    // The rebinding-adjacent case: the name passes the allowlist, and the
    // address it resolves to is refused anyway.
    const result = await sendReplay({
      baseUrl: "http://169.254.169.254",
      path: "/latest/meta-data/iam/security-credentials/",
      method: "POST",
      headers: {},
      payload: {},
      allowedHosts: ["169.254.169.254"]
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.blocked) {
      expect(result.reason).toBe("address_not_allowed");
      expect(result.message).toContain("metadata");
    }
  });

  it("reaches an IPv4-only listener through a name that resolves to IPv6 first", async () => {
    // `localhost` answers ::1 before 127.0.0.1 on many machines, and the
    // resolver's order is not guaranteed. Taking the first address made this
    // suite pass or fail depending on which one came back — and would have made
    // a real destination intermittently unreachable. Every resolved address is
    // tried.
    const { lookup } = await import("node:dns/promises");
    const addresses = await lookup("localhost", { all: true });
    expect(addresses.length).toBeGreaterThan(1);

    const result = await send("/replay/customer");
    expect(result.ok).toBe(true);
  });

  it("refuses a name that does not resolve", async () => {
    const result = await sendReplay({
      baseUrl: "http://does-not-exist.invalid",
      path: "/x",
      method: "POST",
      headers: {},
      payload: {},
      allowedHosts: ["does-not-exist.invalid"]
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.blocked) expect(result.reason).toBe("dns_failed");
  });
});
