import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: "0.1",
    event: {
      id: "evt_1",
      journeyId: "jrn_1",
      environment: "development",
      service: "customer-integration",
      entity: { type: "customer", id: "0018Z00002ABC" },
      operation: "transformed",
      name: "transform-salesforce-account",
      timestamp: "2026-08-06T18:31:04.120Z",
      aliases: { salesforceAccountId: "0018Z00002ABC" },
      input: { phone: "+1 919 555 1234", authorization: "Bearer secret" },
      output: { phone: null, authorization: "Bearer secret" },
      ...overrides
    }
  };
}

describe("event ingestion", () => {
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
    const generated = generateApiKey(subkeys.apiKey);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier
    });

    app = buildApp({
      db,
      subkeys,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const send = (payload: unknown, key = apiKey) =>
    app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${key}` },
      payload: payload as object
    });

  it("accepts a valid event and creates the journey", async () => {
    const response = await send(event());
    expect(response.statusCode).toBe(202);
    expect(response.json().data.duplicate).toBe(false);

    const journey = await db("journeys").where({ project_id: projectId, id: "jrn_1" }).first();
    expect(journey.event_count).toBe(1);
  });

  it("redacts built-in secrets before persistence", async () => {
    const row = await db("journey_events").where({ project_id: projectId, id: "evt_1" }).first();
    expect(row.input_payload.authorization).toBe("[REDACTED]");
    expect(row.input_payload.phone).toBe("+1 919 555 1234");
  });

  it("stores a diff identifying the changed field", async () => {
    const row = await db("journey_events").where({ project_id: projectId, id: "evt_1" }).first();
    expect(row.payload_diff.changes).toContainEqual({
      path: "phone",
      kind: "changed",
      before: "+1 919 555 1234",
      after: null
    });
  });

  it("stores the alias once even when resent", async () => {
    await send(event());
    const count = await db("entity_aliases")
      .where({ project_id: projectId, journey_id: "jrn_1" })
      .count({ n: "*" })
      .first();
    expect(count).toEqual({ n: "1" });
  });

  it("is idempotent for an identical resubmission", async () => {
    const response = await send(event());
    expect(response.json().data.duplicate).toBe(true);

    const journey = await db("journeys").where({ project_id: projectId, id: "jrn_1" }).first();
    expect(journey.event_count).toBe(1);
  });

  it("rejects the same event id with different content", async () => {
    const response = await send(event({ name: "different-name" }));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("event_id_conflict");
  });

  it("rejects a missing key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: event() as object
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects the admin token at ingestion", async () => {
    // An admin token names no environment, and ingestion must write into a
    // specific one, so accepting it here would mean guessing (ADR-029).
    const response = await send(event({ id: "evt_admin" }), "admin-token-for-tests-0000000000");
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown key", async () => {
    expect((await send(event(), "fr_totallyfakekeyvalue")).statusCode).toBe(401);
  });

  it("rejects an event naming another environment", async () => {
    const response = await send(event({ id: "evt_env", environment: "production" }));
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("unauthorized_environment");
  });

  it("rejects a malformed event with a stable code", async () => {
    const response = await send({ protocolVersion: "0.1", event: { id: "evt_bad" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_event");
  });

  it("rejects an unsupported protocol version", async () => {
    const response = await send({ protocolVersion: "9.9", event: {} });
    expect(response.json().error.code).toBe("unsupported_protocol_version");
  });

  it("returns per-event results for a partially invalid batch", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        events: [
          event({ id: "evt_batch_ok", journeyId: "jrn_batch" }),
          { protocolVersion: "0.1", event: { id: "evt_batch_bad" } }
        ]
      } as object
    });

    expect(response.statusCode).toBe(202);
    const results = response.json().data.results;
    expect(results[0].status).toBe("accepted");
    expect(results[1].status).toBe("rejected");

    const stored = await db("journey_events")
      .where({ project_id: projectId, id: "evt_batch_ok" })
      .first();
    expect(stored).toBeDefined();
  });

  it("rejects an oversized batch before processing any event", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { events: Array.from({ length: 101 }, () => event()) } as object
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payload_too_large");
  });

  it("keeps one project's journeys separate from another's", async () => {
    const otherProject = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const otherEnv = await insertReturningId(db, "environments", {
      project_id: otherProject,
      name: "development"
    });
    const otherKey = generateApiKey(subkeys.apiKey);
    await db("api_keys").insert({
      project_id: otherProject,
      environment_id: otherEnv,
      name: "other",
      key_prefix: otherKey.keyPrefix,
      key_hash: otherKey.verifier
    });

    // Same journey id, different project: must create a separate journey.
    await send(event({ id: "evt_other", journeyId: "jrn_1" }), otherKey.apiKey);

    const rows = await db("journeys").where({ id: "jrn_1" });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r: { project_id: string }) => r.project_id)).size).toBe(2);
  });
});
