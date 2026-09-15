import { createKeyring } from "@flight-recorder/payload-security";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Knex } from "knex";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

/** No query in these tests reaches the database. */
const db = {} as Knex;

describe("error envelope", () => {
  it("wraps a body over the limit in the project's error shape", async () => {
    const app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "silent",
      bodyLimit: 128
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: "Bearer irrelevant", "content-type": "application/json" },
      payload: { padding: "x".repeat(4096) }
    });

    expect(response.statusCode).toBe(413);
    // Without setErrorHandler this comes back in Fastify's own shape and a
    // client reading error.code finds nothing.
    const body = response.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe("FST_ERR_CTP_BODY_TOO_LARGE");
    expect(body.error.requestId).toBeTypeOf("string");
    await app.close();
  });

  it("wraps malformed JSON in the same shape", async () => {
    const app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: "Bearer irrelevant", "content-type": "application/json" },
      payload: "{not json"
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBeTypeOf("string");
    await app.close();
  });
});

describe("body limit", () => {
  it("admits a full batch rather than rejecting it", async () => {
    // Fastify's 1 MiB default is far below 100 events at 256 KiB each, so a
    // legitimate batch used to 413 — and the SDK requeues a rejected batch to
    // the front of its queue, blocking everything behind it.
    const app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "silent",
      maxEventPayloadBytes: 262_144
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: "Bearer irrelevant", "content-type": "application/json" },
      // 2 MiB: over Fastify's default, well inside 100 × 256 KiB.
      payload: { events: [{ padding: "x".repeat(2 * 1024 * 1024) }] }
    });

    expect(response.statusCode).not.toBe(413);
    await app.close();
  });
});

describe("log redaction", () => {
  /** Captures what the logger actually writes, which is the claim being tested. */
  function appWithCapturedLogs(): { app: ReturnType<typeof buildApp>; lines: string[] } {
    const lines: string[] = [];
    const app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "info",
      logStream: {
        write: (line: string) => {
          lines.push(line);
        }
      }
    });
    return { app, lines };
  }

  it("never writes a presented API key to the log", async () => {
    // SECURITY.md section 12. This is the property that matters: a real request
    // carries a key in a header, and no log line may contain it. Fastify's
    // request serialiser drops headers before redaction is reached, so this
    // passes by serialiser today and by redaction if that ever changes — which
    // is why it asserts on the outcome rather than on the mechanism.
    const { app, lines } = appWithCapturedLogs();

    await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer fr_secret_value_here", cookie: "flight_session=abc.def" }
    });

    const written = lines.join("");
    expect(written).not.toContain("fr_secret_value_here");
    expect(written).not.toContain("abc.def");
    await app.close();
  });

  it("censors an authorization header logged explicitly", async () => {
    // The serialiser does not cover a log call that builds its own object, so
    // the redact configuration has to.
    const { app, lines } = appWithCapturedLogs();
    app.log.info(
      { headers: { authorization: "Bearer fr_secret_value_here", "user-agent": "probe" } },
      "explicit"
    );

    const written = lines.join("");
    expect(written).not.toContain("fr_secret_value_here");
    expect(written).toContain("[REDACTED]");
    // Redaction, not suppression: the rest of the object survives.
    expect(written).toContain("user-agent");
    await app.close();
  });

  it("leaves an ordinary field alone", async () => {
    // Without this, a redact configuration that censored everything would pass
    // the two tests above.
    const { app, lines } = appWithCapturedLogs();
    app.log.info({ journeyId: "jrn_visible" }, "probe");
    expect(lines.join("")).toContain("jrn_visible");
    await app.close();
  });
});
