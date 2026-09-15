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

  it("rejects a malformed cursor", async () => {
    const response = await get("/v1/search?q=0018Z00002ABC&cursor=garbage");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_cursor");
  });

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/search?q=x" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the journey with masked aliases and distinct services", async () => {
    const data = (await get("/v1/journeys/jrn_q")).json().data;
    expect(data.entity.id).toBe("0018Z00002ABC");
    expect(data.aliases[0]).toEqual({ type: "salesforceAccountId", displayValue: "SF-A…001" });
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
