import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

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

  it("redacts built-in secrets wherever they are nested", async () => {
    // This assertion used to read only the top level, and the built-in list
    // only reached one below it. A payload carrying an axios error's request
    // config was written to `journey_events.input_payload` as plaintext — read
    // back out of PostgreSQL to confirm, not inferred from the function.
    await send(
      event({
        id: "evt_nested_secrets",
        // Its own journey: `jrn_1`'s event_count is asserted elsewhere.
        journeyId: "jrn_secrets",
        input: {
          config: { headers: { authorization: "Bearer sk_live_NESTED" } },
          request: { body: { user: { password: "hunter2-NESTED" } } },
          batch: [{ api_key: "ak_IN_AN_ARRAY" }],
          orderTotal: 4210
        },
        output: { ok: true }
      })
    );

    const row = await db("journey_events")
      .where({ project_id: projectId, id: "evt_nested_secrets" })
      .first();
    const stored = JSON.stringify(row.input_payload);

    expect(stored).not.toContain("sk_live_NESTED");
    expect(stored).not.toContain("hunter2-NESTED");
    expect(stored).not.toContain("ak_IN_AN_ARRAY");
    // Evidence is preserved, and the business data around it survives — a
    // redaction that stored nothing would satisfy the three assertions above.
    expect(row.input_payload.config.headers.authorization).toBe("[REDACTED]");
    expect(row.input_payload.orderTotal).toBe(4210);
  });

  it("redacts secrets in custom metadata", async () => {
    // `applyCapture` ran on `input` and `output` and on nothing else, so
    // `metadata` — the one free-form record among the remaining fields — went
    // to jsonb verbatim. The Node SDK redacts it client-side, but ingestion is
    // public HTTP and a non-SDK client runs none of that.
    await send(
      event({
        id: "evt_meta_secrets",
        journeyId: "jrn_meta",
        input: { ok: true },
        output: { ok: true },
        metadata: { authorization: "Bearer sk_live_META", tenant: "acme" }
      })
    );

    const row = await db("journey_events")
      .where({ project_id: projectId, id: "evt_meta_secrets" })
      .first();

    expect(JSON.stringify(row.custom_metadata)).not.toContain("sk_live_META");
    // The control: redaction, not deletion — the rest of the metadata is why
    // somebody attached it.
    expect(row.custom_metadata.tenant).toBe("acme");
    expect(row.custom_metadata.authorization).toBe("[REDACTED]");
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
    const otherKey = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: otherProject,
      environment_id: otherEnv,
      name: "other",
      key_prefix: otherKey.keyPrefix,
      key_hash: otherKey.verifier,
      key_hash_key_id: otherKey.keyHashKeyId
    });

    // Same journey id, different project: must create a separate journey.
    await send(event({ id: "evt_other", journeyId: "jrn_1" }), otherKey.apiKey);

    const rows = await db("journeys").where({ id: "jrn_1" });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r: { project_id: string }) => r.project_id)).size).toBe(2);
  });

  describe("an event PostgreSQL cannot store", () => {
    const NUL = "\u0000";

    it("rejects only the poisoned event, and keeps the rest of the batch", async () => {
      // The comment in the batch loop claimed events were independent. Before
      // the try/catch it was not true: the throw escaped the loop and returned
      // a 500 that discarded the whole batch, including events already stored.
      const response = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          events: [
            event({ id: "evt_ok_1" }),
            event({ id: "evt_nul", input: { name: `Dana${NUL}` } }),
            event({ id: "evt_ok_2" })
          ]
        }
      });

      expect(response.statusCode).toBe(202);
      const results = response.json<{ data: { results: { status: string }[] } }>().data.results;
      expect(results).toHaveLength(3);
      expect(results[0]?.status).toBe("accepted");
      expect(results[2]?.status).toBe("accepted");
      // The poisoned one must be refused, not quietly accepted — otherwise
      // this test would pass on a build that never exercised the guard.
      expect(results[1]?.status).toBe("rejected");
      expect(JSON.stringify(results[1])).toContain("unstorable_payload");
    });

    it("never publishes a raw SQLSTATE as the API error code", async () => {
      // A pg error carries .code — a SQLSTATE like 22P05 — and no .statusCode,
      // so the shared error handler used to publish it verbatim. "22P05" tells
      // an SDK user nothing about what to change.
      const response = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { events: [event({ id: "evt_nul_2", input: { name: `X${NUL}` } })] }
      });

      const body = JSON.stringify(response.json());
      expect(body).not.toMatch(/"22P05"|"22021"/);
    });
  });
});
