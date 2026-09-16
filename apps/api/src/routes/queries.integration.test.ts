import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

describe("query endpoints", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });

    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });

    // Build the fixture through the real write path, so these tests exercise
    // what ingestion actually produces rather than hand-inserted rows that could
    // drift from it.
    const ingest = (id: string, at: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            id,
            journeyId: "jrn_q",
            environment: "development",
            service: "customer-integration",
            entity: { type: "customer", id: "0018Z00002ABC" },
            operation: "transformed",
            name: "transform-salesforce-account",
            timestamp: at,
            // A value distinct from entity.id, so a search for it can only
            // succeed through the alias path.
            aliases: { salesforceAccountId: "SF-ALIAS-99001" },
            ...extra
          }
        } as object
      });

    await ingest("evt_q1", "2026-08-06T10:00:00.000Z", {
      input: { phone: "+1 919 555 1234" },
      output: { phone: null },
      traceId: "trace-q"
    });
    await ingest("evt_q2", "2026-08-06T11:00:00.000Z");
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const get = (url: string, key = apiKey) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

  it("finds the journey by entity id", async () => {
    const response = await get("/v1/search?q=0018Z00002ABC");
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0].journeyId).toBe("jrn_q");
  });

  it("finds the journey by alias value without its type", async () => {
    // The alias value differs from entity.id, so this can only match via the
    // alias path — the ADR-028 property.
    const response = await get("/v1/search?q=SF-ALIAS-99001");
    expect(response.json().data.items[0].journeyId).toBe("jrn_q");
  });

  it("finds the journey by trace id", async () => {
    expect((await get("/v1/search?q=trace-q")).json().data.items[0].journeyId).toBe("jrn_q");
  });

  it("returns the entity id in full", async () => {
    const item = (await get("/v1/search?q=0018Z00002ABC")).json().data.items[0];
    expect(item.entity.id).toBe("0018Z00002ABC");
  });

  it("requires a query string", async () => {
    expect((await get("/v1/search")).statusCode).toBe(400);
  });

  it("refuses a repeated q or cursor with 400 rather than failing", async () => {
    // Fastify parses a repeated parameter into an array, and `.trim()` on an
    // array threw: a 500 for a malformed URL.
    for (const url of [
      "/v1/search?q=a&q=b",
      "/v1/search?q=0018Z00002ABC&cursor=a&cursor=b",
      "/v1/journeys/jrn_q/events?cursor=a&cursor=b"
    ]) {
      const response = await get(url);
      expect(response.statusCode, `${url} ${response.body}`).toBe(400);
      expect(["invalid_query", "invalid_cursor"]).toContain(response.json().error.code);
    }
  });

  describe("a null byte anywhere in the request", () => {
    // PostgreSQL refuses a NUL in text with 22021, and every one of these
    // reached a query and came back 500. A NUL cannot be part of any stored
    // id, identifier, name or cursor, so it is refused before the database.
    const cursorWith = (value: Record<string, unknown>): string =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

    it("answers a path id holding one with 404, for an API key and an admin", async () => {
      for (const url of [
        "/v1/journeys/jrn%00q",
        "/v1/journeys/jrn%00q/events",
        "/v1/events/evt%00q1"
      ]) {
        for (const token of [apiKey, "admin-token-for-tests-0000000000"]) {
          const response = await get(url, token);
          expect(response.statusCode, `${url} ${response.body}`).toBe(404);
          expect(response.json().error.code).toBe("not_found");
        }
      }
    });

    it("refuses one in a query parameter with 400", async () => {
      const since = "2026-01-01T00:00:00Z";
      for (const url of [
        "/v1/search?q=00%0018Z",
        `/v1/journeys?since=${since}&environment=dev%00`,
        `/v1/journeys?since=${since}&service=svc%00`
      ]) {
        const response = await get(url);
        expect(response.statusCode, `${url} ${response.body}`).toBe(400);
        expect(response.json().error.code).toBe("invalid_query");
      }
    });

    it("refuses one inside a cursor as a malformed cursor", async () => {
      const nul = String.fromCharCode(0);
      for (const url of [
        `/v1/search?q=0018Z00002ABC&cursor=${cursorWith({ lastEventAt: "2026-08-06T10:00:00.000Z", id: `jrn${nul}` })}`,
        `/v1/journeys?since=2026-01-01T00:00:00Z&cursor=${cursorWith({ lastEventAt: "2026-08-06T10:00:00.000Z", id: `jrn${nul}` })}`,
        `/v1/journeys/jrn_q/events?cursor=${cursorWith({ eventTimestamp: "2026-08-06T10:00:00.000Z", receivedAt: "2026-08-06T10:00:00.000Z", id: `evt${nul}` })}`
      ]) {
        const response = await get(url);
        expect(response.statusCode, `${url} ${response.body}`).toBe(400);
        expect(response.json().error.code).toBe("invalid_cursor");
      }
    });
  });

  describe("a cursor timestamp outside the years PostgreSQL reads", () => {
    // `new Date(x).toISOString() === x` held for year 0000, negative years,
    // and six-digit years, all of which PostgreSQL refuses in a timestamptz
    // comparison: a 500 on every list route.
    const cursor = (value: Record<string, unknown>): string =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const routes = (at: string): [string, string][] => [
      [
        "journeys",
        `/v1/journeys?since=2026-01-01T00:00:00Z&cursor=${cursor({ lastEventAt: at, id: "x" })}`
      ],
      ["search", `/v1/search?q=0018Z00002ABC&cursor=${cursor({ lastEventAt: at, id: "x" })}`],
      [
        "events, eventTimestamp",
        `/v1/journeys/jrn_q/events?cursor=${cursor({ eventTimestamp: at, receivedAt: "2026-01-01T00:00:00.000Z", id: "x" })}`
      ],
      [
        "events, receivedAt",
        `/v1/journeys/jrn_q/events?cursor=${cursor({ eventTimestamp: "2026-01-01T00:00:00.000Z", receivedAt: at, id: "x" })}`
      ]
    ];

    it("is refused as a malformed cursor on every route", async () => {
      for (const at of [
        "0000-01-01T00:00:00.000Z",
        "-000001-01-01T00:00:00.000Z",
        "-004714-11-23T00:00:00.000Z",
        "-271821-04-20T00:00:00.000Z",
        "+010000-01-01T00:00:00.000Z",
        "+275760-09-13T00:00:00.000Z"
      ]) {
        for (const [route, url] of routes(at)) {
          const response = await get(url);
          expect(response.statusCode, `${at} ${route} ${response.body}`).toBe(400);
          expect(response.json().error.code).toBe("invalid_cursor");
        }
      }
    });

    it("is read at the first and last years it can be", async () => {
      for (const at of ["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
        for (const [route, url] of routes(at)) {
          const response = await get(url);
          expect(response.statusCode, `${at} ${route} ${response.body}`).toBe(200);
        }
      }
    });
  });

  it("rejects a malformed cursor", async () => {
    const response = await get("/v1/search?q=0018Z00002ABC&cursor=garbage");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_cursor");
  });

  it("answers an admin naming a project id that is not a uuid with project_not_found", async () => {
    // Not a server error: PostgreSQL rejects the comparison outright, so the
    // check has to happen before the lookup.
    for (const url of ["/v1/search?q=x", "/v1/journeys/jrn_q"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: {
          authorization: "Bearer admin-token-for-tests-0000000000",
          "x-flight-project-id": "not-a-uuid"
        }
      });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.code).toBe("project_not_found");
    }
  });

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/search?q=x" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the journey with masked aliases and distinct services", async () => {
    const data = (await get("/v1/journeys/jrn_q")).json().data;
    expect(data.entity.id).toBe("0018Z00002ABC");
    expect(data.aliases[0]).toEqual({
      type: "salesforceAccountId",
      displayValue: "SF-A…001",
      displayable: false
    });
    expect(data.services).toEqual(["customer-integration"]);
    expect(data.eventCount).toBe(2);
    // The web interface's delete confirmation names it.
    expect(data.environment).toBe("development");
  });

  it("returns 404 for an unknown journey", async () => {
    expect((await get("/v1/journeys/jrn_nope")).statusCode).toBe(404);
  });

  it("lists events in deterministic order", async () => {
    const items = (await get("/v1/journeys/jrn_q/events")).json().data.items;
    expect(items.map((e: { id: string }) => e.id)).toEqual(["evt_q1", "evt_q2"]);
  });

  it("reports payload presence in the list without sending payloads", async () => {
    const first = (await get("/v1/journeys/jrn_q/events")).json().data.items[0];
    expect(first.hasInput).toBe(true);
    expect(first.inputPayload).toBeUndefined();
  });

  it("returns event detail with payloads and diff", async () => {
    const data = (await get("/v1/events/evt_q1")).json().data;
    expect(data.inputPayload).toEqual({ phone: "+1 919 555 1234" });
    expect(data.payloadDiff.changes[0].path).toBe("phone");
  });

  it("returns 404 for another environment of the same project", async () => {
    // The environment boundary was enforced on /v1/search and on nothing else.
    // A key scoped to development could read a production journey, its events,
    // and the full decrypted payload, by id. Verified against a running stack
    // before this test existed: the response carried `salary` and `ssnLast4`.
    //
    // The test above looks like it covers this and does not — it builds a
    // second *project*, which composite keys already make unreachable.
    const productionEnv = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production"
    });
    const productionKey = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: productionEnv,
      name: "prod",
      key_prefix: productionKey.keyPrefix,
      key_hash: productionKey.verifier,
      key_hash_key_id: productionKey.keyHashKeyId
    });

    const written = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${productionKey.apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id: "evt_prod",
          journeyId: "jrn_prod",
          environment: "production",
          service: "payroll",
          entity: { type: "employee", id: "EMP-1" },
          operation: "persisted",
          name: "write-salary",
          timestamp: "2026-08-06T12:00:00.000Z",
          input: { salary: 185_000 }
        }
      } as object
    });
    expect(written.statusCode).toBe(202);

    // `apiKey` is scoped to development.
    expect((await get("/v1/journeys/jrn_prod")).statusCode).toBe(404);
    expect((await get("/v1/journeys/jrn_prod/events")).statusCode).toBe(404);
    expect((await get("/v1/events/evt_prod")).statusCode).toBe(404);

    // The control: the production key can read its own data, so the fix is a
    // boundary rather than a blanket refusal.
    const own = await get("/v1/events/evt_prod", productionKey.apiKey);
    expect(own.statusCode).toBe(200);
    expect(own.json().data.inputPayload).toEqual({ salary: 185_000 });
  });

  it("returns 404 for another project's journey and event", async () => {
    const otherProject = await insertReturningId(db, "projects", { name: "O2", slug: "o2" });
    const otherEnv = await insertReturningId(db, "environments", {
      project_id: otherProject,
      name: "development"
    });
    const otherKey = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: otherProject,
      environment_id: otherEnv,
      name: "other",
      key_prefix: otherKey.keyPrefix,
      key_hash: otherKey.verifier,
      key_hash_key_id: otherKey.keyHashKeyId
    });

    expect((await get("/v1/events/evt_q1", otherKey.apiKey)).statusCode).toBe(404);
    expect((await get("/v1/journeys/jrn_q", otherKey.apiKey)).statusCode).toBe(404);
  });
});
