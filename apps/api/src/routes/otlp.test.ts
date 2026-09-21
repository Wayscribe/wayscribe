import { gzipSync } from "node:zlib";
import { createKeyring } from "@wayscribe/payload-security";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const base = {
  db: {} as Knex,
  keyring,
  adminToken: "admin-token-for-tests-0000000000",
  logLevel: "silent"
};
describe("optional OTLP transport", () => {
  it("has no route by default", async () => {
    const app = buildApp(base);
    try {
      expect((await app.inject({ method: "POST", url: "/v1/logs", payload: {} })).statusCode).toBe(
        404
      );
    } finally {
      await app.close();
    }
  });
  it.each(["application/json", "application/x-protobuf"])(
    "uses %s for authentication failures",
    async (contentType) => {
      const app = buildApp({ ...base, otlpLogsEnabled: true });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/logs",
          headers: { "content-type": contentType },
          payload: contentType === "application/json" ? "{}" : Buffer.alloc(0)
        });
        expect(res.statusCode).toBe(401);
        expect(res.headers["content-type"]).toContain(contentType);
        if (contentType === "application/json")
          expect(res.json()).toEqual({ code: 16, message: "Authentication required." });
        else expect(res.rawPayload[0]).toBe(8);
      } finally {
        await app.close();
      }
    }
  );
  it.each([
    ["application/json", "identity", Buffer.alloc(129), 413],
    ["application/x-protobuf", "identity", Buffer.alloc(129), 413],
    ["application/json", "gzip", gzipSync(Buffer.alloc(1000, 32)), 413],
    ["application/x-protobuf", "gzip", gzipSync(Buffer.alloc(1000)), 413],
    ["application/json", "gzip", Buffer.from("secret-invalid-gzip"), 400],
    ["application/x-protobuf", "gzip", gzipSync(Buffer.from("{}")).subarray(0, 15), 400],
    ["application/json", "br", Buffer.from("{}"), 415],
    ["text/plain", "identity", Buffer.from("{}"), 415]
  ] as const)("bounds/parses %s %s safely", async (contentType, coding, payload, status) => {
    const app = buildApp({ ...base, otlpLogsEnabled: true, otlpMaxRequestBytes: 128 });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/logs",
        headers: { "content-type": contentType, "content-encoding": coding },
        payload
      });
      expect(res.statusCode).toBe(status);
      expect(res.body).not.toContain("secret");
      expect(res.headers["content-type"]).toContain(
        contentType === "application/x-protobuf" ? contentType : "application/json"
      );
    } finally {
      await app.close();
    }
  });
});
