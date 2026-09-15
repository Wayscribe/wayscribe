import { describe, expect, it } from "vitest";
import { serializeError, serializeRequest, urlForLog } from "./log-url.js";

describe("urlForLog", () => {
  it.each([
    ["/v1/journeys/jrn_1", "/v1/journeys/jrn_1"],
    ["/v1/search?", "/v1/search"],
    ["/v1/search?q=CUST-1", "/v1/search?q=[REDACTED]"],
    ["/v1/search?q=", "/v1/search?q=[REDACTED]"],
    ["/v1/search?q=a=b&limit=5", "/v1/search?q=[REDACTED]&limit=[REDACTED]"],
    ["/v1/search?cursor", "/v1/search?cursor=[REDACTED]"],
    ["/v1/search?q=x&&limit=1", "/v1/search?q=[REDACTED]&&limit=[REDACTED]"],
    ["/v1/search?person%40example.com", "/v1/search?[REDACTED]"],
    ["/v1/search?1234=x", "/v1/search?[REDACTED]"]
  ])("logs %s as %s", (url, logged) => {
    expect(urlForLog(url)).toBe(logged);
  });
});

describe("serializeError", () => {
  it("keeps type, message, stack, code, and cause, and drops rawPacket at every level", () => {
    const cause = Object.assign(new Error("inner"), {
      code: "HPE_INVALID",
      rawPacket: Buffer.from("Authorization: Bearer fr_inner")
    });
    const error = Object.assign(new TypeError("outer", { cause }), {
      statusCode: 400,
      rawPacket: Buffer.from("Authorization: Bearer fr_outer")
    });

    const logged = serializeError(error);

    expect(logged).toMatchObject({ type: "TypeError", message: "outer", statusCode: 400 });
    expect(logged.stack).toContain("outer");
    expect(logged).not.toHaveProperty("rawPacket");
    expect(logged["cause"]).toMatchObject({ type: "Error", message: "inner", code: "HPE_INVALID" });
    expect(logged["cause"]).not.toHaveProperty("rawPacket");
  });
});

describe("serializeRequest", () => {
  it("keeps Fastify's default fields, with the URL made safe and no headers", () => {
    expect(
      serializeRequest({
        method: "GET",
        url: "/v1/search?q=CUST-1",
        host: "api:8080",
        ip: "10.0.0.5",
        socket: { remotePort: 51234 },
        headers: { authorization: "Bearer fr_secret" }
      })
    ).toEqual({
      method: "GET",
      url: "/v1/search?q=[REDACTED]",
      host: "api:8080",
      remoteAddress: "10.0.0.5",
      remotePort: 51234
    });
  });
});
