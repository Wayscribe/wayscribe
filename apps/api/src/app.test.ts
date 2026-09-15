import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
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

describe("an Authorization header with anything after the token", () => {
  // `Bearer <token> extra` authenticated as `Bearer <token>`: everything after
  // the second space was ignored, for the admin token and API keys alike. It
  // is refused before any lookup, so these run with no database at all.
  const extra = [" ", " extra", "  ", " Bearer x"];

  it("is 401 on every kind of route, with the admin token", async () => {
    const app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    let source = 0;
    for (const suffix of extra) {
      for (const [method, url] of [
        ["GET", "/v1/projects"],
        ["GET", "/v1/journeys/jrn_1"],
        ["DELETE", "/v1/journeys/jrn_1"],
        ["GET", "/v1/replay-destinations"]
      ] as const) {
        // Each from its own address, so the authentication throttle's 429
        // cannot stand in for the 401 under test.
        source += 1;
        const response = await app.inject({
          method,
          url,
          remoteAddress: `198.51.100.${String(source)}`,
          headers: { authorization: `Bearer ${ADMIN_TOKEN}${suffix}` }
        });
        expect(response.statusCode, `${method} ${url} ${JSON.stringify(suffix)}`).toBe(401);
      }
    }
    await app.close();
  });

  it("is 401 at ingestion, with an API key", async () => {
    const app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    const key = issueApiKey(keyring).apiKey;
    for (const suffix of [" extra", " "]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${key}${suffix}` },
        payload: {}
      });
      expect(response.statusCode, JSON.stringify(suffix)).toBe(401);
    }
    await app.close();
  });
});

describe("an unexpected database error", () => {
  it("is internal_error, never the driver's SQLSTATE", async () => {
    // A pg error carries `.code`, a SQLSTATE, and no `.statusCode`, and the
    // handler used to publish that code as the API's own. Every lookup here
    // fails the way PostgreSQL refuses a malformed uuid.
    for (const sqlState of ["22P02", "22P05", "23505", "42P01"]) {
      const failing = (() => {
        throw Object.assign(new Error("invalid input syntax for type uuid"), { code: sqlState });
      }) as unknown as Knex;
      const app = buildApp({ db: failing, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });

      const response = await app.inject({
        method: "GET",
        url: "/v1/journeys/jrn_1",
        headers: { authorization: "Bearer fr_0000000000000000000000000000000" }
      });

      expect(response.statusCode, sqlState).toBe(500);
      const body = response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code, sqlState).toBe("internal_error");
      expect(response.body).not.toContain(sqlState);
      expect(response.body).not.toContain("uuid");
      await app.close();
    }
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

describe("query strings in the log", () => {
  // A search's `q` is usually a customer identifier, and the Recent page's
  // filters name services and environments. Fastify's request log line used to
  // carry `req.url` whole, so every search wrote the identifier to the log.
  const VALUE = "CUST-LOGGED-8841";

  function appWithCapturedLogs(): { app: ReturnType<typeof buildApp>; lines: string[] } {
    const lines: string[] = [];
    const app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "trace",
      logStream: {
        write: (line: string) => {
          lines.push(line);
        }
      }
    });
    return { app, lines };
  }

  it("logs a search's path, and never the searched value", async () => {
    const { app, lines } = appWithCapturedLogs();

    // No credentials: the route answers 401 before any database access, and
    // the request is still logged on the way in and out.
    const response = await app.inject({ method: "GET", url: `/v1/search?q=${VALUE}` });
    expect(response.statusCode).toBe(401);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(VALUE);
    const incoming = lines
      .map((line) => JSON.parse(line) as { req?: { url?: string } })
      .find((line) => line.req?.url !== undefined);
    expect(incoming?.req?.url).toBe("/v1/search?q=[REDACTED]");
    await app.close();
  });

  it("keeps parameter names and hides every value, including repeated ones", async () => {
    const { app, lines } = appWithCapturedLogs();

    await app.inject({
      method: "GET",
      url: `/v1/journeys?since=2026-09-15T00:00:00Z&service=${VALUE}&environment=${VALUE}-env&status=failed&status=completed`
    });

    const written = lines.join("");
    expect(written).not.toContain(VALUE);
    expect(written).not.toContain("2026-09-15T00:00:00Z");
    expect(written).toContain(
      "/v1/journeys?since=[REDACTED]&service=[REDACTED]&environment=[REDACTED]&status=[REDACTED]&status=[REDACTED]"
    );
    await app.close();
  });

  it("hides a parameter name that could itself be a value", async () => {
    const { app, lines } = appWithCapturedLogs();

    // A name with characters no real parameter uses, or one too long to be a
    // name, is treated as data.
    await app.inject({ method: "GET", url: `/v1/search?${VALUE}@example.com&q=x` });
    await app.inject({ method: "GET", url: `/v1/search?${"n".repeat(80)}=x` });

    const written = lines.join("");
    expect(written).not.toContain(`${VALUE}@example.com`);
    expect(written).not.toContain("n".repeat(80));
    expect(written).toContain("/v1/search?[REDACTED]&q=[REDACTED]");
    await app.close();
  });

  it("keeps the value out of a request no route matches", async () => {
    // Fastify's own not-found handler logged `Route GET:<url> not found` with
    // the query string, and echoed the URL back in its body.
    const { app, lines } = appWithCapturedLogs();

    const response = await app.inject({ method: "GET", url: `/v1/serach?q=${VALUE}` });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(VALUE);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("not_found");
    const written = lines.join("");
    expect(written).not.toContain(VALUE);
    expect(written).toContain("/v1/serach");
    await app.close();
  });

  it("treats a semicolon like a question mark, in the log and in a not-found body", async () => {
    // `;` starts matrix parameters, and some clients and proxies put session
    // ids and tokens there.
    const { app, lines } = appWithCapturedLogs();

    const response = await app.inject({
      method: "GET",
      url: `/v1/serach;jsessionid=${VALUE}?q=${VALUE}-q`
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(VALUE);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "GET /v1/serach."
    );
    const written = lines.join("");
    expect(written).not.toContain(VALUE);
    expect(written).toContain("/v1/serach;[REDACTED]?q=[REDACTED]");
    await app.close();
  });

  it("keeps the value out of an error the request caused", async () => {
    const { app, lines } = appWithCapturedLogs();

    const response = await app.inject({
      method: "POST",
      url: `/v1/events?q=${VALUE}`,
      headers: { authorization: "Bearer irrelevant", "content-type": "application/json" },
      payload: "{not json"
    });

    expect(response.statusCode).toBe(400);
    expect(lines.join("")).not.toContain(VALUE);
    await app.close();
  });

  it("still censors headers logged explicitly", async () => {
    const { app, lines } = appWithCapturedLogs();
    app.log.info({ headers: { authorization: "Bearer fr_still_secret_000" } }, "explicit");
    const written = lines.join("");
    expect(written).not.toContain("fr_still_secret_000");
    expect(written).toContain("[REDACTED]");
    await app.close();
  });
});

describe("a request too malformed for HTTP", () => {
  // Node's parser rejects it before Fastify sees a request, and Fastify's
  // default client-error handler logged `{ err }` at trace. The parser's error
  // carries `rawPacket`, the request bytes as received: every header, the
  // bearer key among them, and the query string.
  const TOKEN = "fr_rawpacket_token_5d2c81e9a0b4";
  const VALUE = "CUST-RAWPACKET-3317";

  /** Send raw bytes to the app and wait until the server closes the connection. */
  async function sendRaw(port: number, bytes: string): Promise<string> {
    const { connect } = await import("node:net");
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(bytes);
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => {
        resolve(received);
      });
      socket.on("error", reject);
    });
  }

  it("logs neither its bearer key nor its query values, even at trace", async () => {
    const lines: string[] = [];
    const app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "trace",
      logStream: {
        write: (line: string) => {
          lines.push(line);
        }
      }
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };

    const response = await sendRaw(
      port,
      `GET /v1/search?q=${VALUE} HTTP/1.1\r\n` +
        "Host: localhost\r\n" +
        `Authorization: Bearer ${TOKEN}\r\n` +
        "Content-Length: not-a-number\r\n\r\n"
    );

    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    // The failure is still logged, so the check is not passing on silence.
    expect(lines.some((line) => line.includes("client error"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(VALUE);
      // pino writes a Buffer as an array of byte values, so the token would
      // not appear as text even when the packet is logged. The packet must
      // not be there at all.
      expect(line).not.toContain("rawPacket");
    }
    await app.close();
  });

  it("never serialises an error's rawPacket, whoever logs it", async () => {
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
    const error = Object.assign(new Error("Parse Error: Invalid character"), {
      code: "HPE_INVALID_HEADER_TOKEN",
      rawPacket: Buffer.from(`GET /?q=${VALUE} HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\n`)
    });

    app.log.error({ err: error }, "probe");

    const written = lines.join("");
    expect(written).toContain("HPE_INVALID_HEADER_TOKEN");
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(VALUE);
    expect(written).not.toContain("rawPacket");
    await app.close();
  });
});
