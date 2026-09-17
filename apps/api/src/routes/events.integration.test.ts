import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { buildJsonSchemas } from "@flight-recorder/protocol";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
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
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
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

    it("refuses it from the single-event route as the batch route does", async () => {
      // The batch route mapped the storage error to 400 unstorable_payload;
      // the single route let it reach the error handler, which answered 500
      // with error.code "22P05". Same event, two different contracts.
      const response = await send(event({ id: "evt_nul_single", input: { name: `Dana${NUL}` } }));

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("unstorable_payload");
      expect(
        await db("journey_events").where({ project_id: projectId, id: "evt_nul_single" }).first()
      ).toBeUndefined();
    });

    it("refuses a lone surrogate from both routes as unstorable", async () => {
      // Sent as a JSON escape, so the parsed string really holds the lone
      // half; a raw one in the body would be replaced by the HTTP layer.
      // PostgreSQL refuses it in jsonb with 22P02, which neither route mapped:
      // the single route answered 500 with that code, the batch route 500.
      const withSurrogate = (id: string): string =>
        JSON.stringify(event({ id, journeyId: "jrn_surrogate", input: { name: "X" } })).replace(
          '"name":"X"',
          '"name":"X\\ud800"'
        );
      const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

      const single = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers,
        payload: withSurrogate("evt_surrogate_single")
      });
      expect(single.statusCode, single.body).toBe(400);
      expect(single.json().error.code).toBe("unstorable_payload");

      const batch = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers,
        payload: `{"events":[${withSurrogate("evt_surrogate_batch")}]}`
      });
      const result = batch.json().data.results[0];
      expect(result.status).toBe("rejected");
      expect(result.error.code).toBe("unstorable_payload");
      expect(result.error.httpStatus).toBe(400);

      expect(single.body + batch.body).not.toMatch(/22P05|22021|22P02/);
    });

    it("refuses a duration too large to store as a validation error, on both routes", async () => {
      const tooLong = event({
        id: "evt_duration_max",
        journeyId: "jrn_duration",
        durationMs: 2 ** 31
      });
      const single = await send(tooLong);
      expect(single.statusCode, single.body).toBe(400);
      expect(single.json().error.code).toBe("invalid_event");

      const batch = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { events: [tooLong] } as object
      });
      const result = batch.json().data.results[0];
      expect(result.status).toBe("rejected");
      // A 4xx: permanent, so the SDK does not resend it.
      expect(result.error.httpStatus).toBe(400);
      expect(result.error.code).toBe("invalid_event");

      const fits = await send(
        event({ id: "evt_duration_fits", journeyId: "jrn_duration", durationMs: 2 ** 31 - 1 })
      );
      expect(fits.statusCode, fits.body).toBe(202);
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

  describe("a __proto__ key the sender wrote, end to end", () => {
    /**
     * Sent as raw bytes, and every expectation read back out of PostgreSQL.
     *
     * An object literal with `__proto__:` sets the prototype and never creates
     * an own key, so a test written that way would send nothing at all and
     * pass against the defect. This is the shape a webhook body actually has.
     */
    const rawEnvelope = String.raw`{"protocolVersion":"0.1","event":{"id":"evt_proto","journeyId":"jrn_proto","environment":"development","service":"customer-integration","entity":{"type":"customer","id":"0018Z00002ABC"},"operation":"transformed","name":"transform-salesforce-account","timestamp":"2026-08-06T18:31:04.120Z","aliases":{"__proto__":"alias-under-proto","salesforceAccountId":"0018Z00002ABC"},"metadata":{"__proto__":"metadata-under-proto","attempt":"1"},"input":{"__proto__":"input-under-proto","phone":"+1 919 555 1234"}}}`;

    /** The stored row, with the three jsonb columns these tests read. */
    interface StoredRow {
      custom_metadata: Record<string, unknown>;
      input_payload: Record<string, unknown>;
    }

    const row = async (): Promise<StoredRow> => {
      const found: unknown = await db("journey_events")
        .where({ project_id: projectId, id: "evt_proto" })
        .first();
      expect(found, "the event was not stored").toBeDefined();
      return found as StoredRow;
    };

    beforeAll(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: rawEnvelope
      });
      expect(response.statusCode, response.body).toBe(202);
    });

    it("stores it in custom_metadata, beside the ordinary key", async () => {
      // jsonb is where the key had to survive, and the driver parses it back
      // with JSON.parse, which makes it an own key again.
      const stored = await row();
      expect(Object.hasOwn(stored.custom_metadata, "__proto__")).toBe(true);
      expect(JSON.stringify(stored.custom_metadata)).toContain(
        '"__proto__":"metadata-under-proto"'
      );
      // The neighbour, so a fix that kept the key and lost everything else fails.
      expect(stored.custom_metadata.attempt).toBe("1");
    });

    it("stores it in the input payload, beside the ordinary key", async () => {
      const stored = await row();
      expect(JSON.stringify(stored.input_payload)).toContain('"__proto__":"input-under-proto"');
      expect(stored.input_payload.phone).toBe("+1 919 555 1234");
    });

    it("stores it as an alias type, beside the ordinary alias", async () => {
      const aliases: { alias_type: string }[] = await db("entity_aliases")
        .where({ project_id: projectId, journey_id: "jrn_proto" })
        .select("alias_type");
      expect(aliases.map((alias) => alias.alias_type).sort()).toEqual([
        "__proto__",
        "salesforceAccountId"
      ]);
    });

    it("is still there when the API reads the event back", async () => {
      // Stored is not enough if the read path or Fastify's serializer spends
      // the key on a prototype on the way out. Asserted on the reply's bytes.
      const response = await app.inject({
        method: "GET",
        url: "/v1/events/evt_proto",
        headers: { authorization: `Bearer ${apiKey}` }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain('"__proto__":"metadata-under-proto"');
      expect(response.body).toContain('"__proto__":"input-under-proto"');
      expect(response.json().data.customMetadata.attempt).toBe("1");
    });

    it("refuses an alias __proto__ whose value is not a string", async () => {
      // z.record does not validate this key's value at all, so restoring it
      // unchecked would put a value the schema refuses into a field that
      // encryption and the search token both expect to be a string.
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: String.raw`{"protocolVersion":"0.1","event":{"id":"evt_proto_bad","journeyId":"jrn_proto_bad","environment":"development","service":"customer-integration","entity":{"type":"customer","id":"1"},"operation":"received","name":"n","timestamp":"2026-08-06T18:31:04.120Z","aliases":{"__proto__":{"nested":true}}}}`
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_event");

      const stored = await db("journey_events")
        .where({ project_id: projectId, id: "evt_proto_bad" })
        .first();
      expect(stored).toBeUndefined();
    });
  });

  describe("a content type the framework parses but this API cannot use", () => {
    /**
     * `text/plain` is not a 415.
     *
     * The framework has a parser for it, so the body arrives as a string, and a
     * string is not an envelope: both routes answer `400 invalid_event`. The
     * ingestion contract section 2 says so, under the refusals that do not look
     * like the rest, and this is what keeps that sentence true. The 415 is for
     * a content type with no parser at all.
     *
     * Here rather than in `app.test.ts` because it needs a key that resolves:
     * with a stub database the request gets past the parser and then fails the
     * lookup, which proves nothing about the parser.
     */
    it.each(["/v1/events", "/v1/events/batch"])("%s answers 400 invalid_event", async (url) => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "text/plain" },
        payload: JSON.stringify(event({ id: "evt_plain", journeyId: "jrn_plain" }))
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_event");
    });

    it("is a 415 when nothing can parse the type at all", async () => {
      // The control, so the case above is about the parser rather than about
      // any unusual content type being refused.
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/vnd.api+json"
        },
        payload: "{}"
      });
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe("unsupported_media_type");
    });
  });

  describe("what the routes send, against the generated JSON Schema", () => {
    /**
     * The published schemas for the response shapes describe what the API
     * already sends, and nothing checked that until now. A hand-written schema
     * for a response is a second source of truth that drifts; this is the check
     * that stops it.
     *
     * Ajv reads the generated files exactly as a client in another language
     * would, `$ref` resolution by sibling basename included.
     */
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    const schemas = buildJsonSchemas();
    for (const name of ["event", "stored-event", "stored-journey", "event-result"]) {
      ajv.addSchema(schemas[name] ?? {});
    }
    const batchResponse = ajv.compile(schemas["batch-response"] ?? {});
    const errorBody = ajv.compile(schemas["error-body"] ?? {});
    const eventAccepted = ajv.compile(schemas["event-accepted"] ?? {});

    const against = (validate: ValidateFunction, body: unknown, what: string): void => {
      expect(validate(body), `${what}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    };

    const batch = (events: unknown[]) =>
      app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { events } as object
      });

    it("validates the 202 of an accepted single event", async () => {
      const response = await send(event({ id: "evt_schema_single", journeyId: "jrn_schema" }));
      expect(response.statusCode, response.body).toBe(202);
      against(eventAccepted, response.json(), "single-event 202");
    });

    it("validates a batch carrying an accept, a duplicate and a rejection at once", async () => {
      const response = await batch([
        event({ id: "evt_schema_batch", journeyId: "jrn_schema" }),
        // The same event again, which is a duplicate in the same request.
        event({ id: "evt_schema_batch", journeyId: "jrn_schema" }),
        { protocolVersion: "0.1", event: { id: "evt_schema_bad" } }
      ]);
      expect(response.statusCode, response.body).toBe(202);
      const results = response.json().data.results;
      // The three shapes the schema has to cover, so a pass is not vacuous.
      expect(results[0].status).toBe("accepted");
      expect(results[1].duplicate).toBe(true);
      expect(results[2].error.code).toBe("invalid_event");
      expect(results[2].error.details.length).toBeGreaterThan(0);
      against(batchResponse, response.json(), "batch 202");
    });

    it.each([
      ["a body with no events array", { notEvents: [] }, "invalid_event"],
      [
        "a batch over the ceiling",
        { events: Array.from({ length: 101 }, () => event()) },
        "payload_too_large"
      ]
    ])("validates the error body of %s", async (_what, payload, code) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events/batch",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: payload as object
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(code);
      against(errorBody, response.json(), "whole-request refusal");
    });

    it("validates the error body of a refused credential", async () => {
      const response = await send(event({ id: "evt_schema_401" }), "fr_not_a_key");
      expect(response.statusCode).toBe(401);
      against(errorBody, response.json(), "401");
    });

    it("validates the error body of a conflict", async () => {
      const response = await send(
        event({ id: "evt_schema_single", journeyId: "jrn_schema", name: "changed" })
      );
      expect(response.statusCode).toBe(409);
      against(errorBody, response.json(), "409");
    });

    it("refuses a response the schema does not describe", () => {
      // The control. Every assertion above would pass against a validator that
      // approves anything, which is exactly what a schema with a typo becomes.
      expect(batchResponse({ data: { results: [{ status: "maybe" }] } })).toBe(false);
      expect(errorBody({ error: { code: "x" } })).toBe(false);
    });

    describe("the batch request corpus the protocol package pins", () => {
      // packages/protocol/src/ingestion.test.ts asserts that the Zod schema and
      // the generated one agree about each of these. This is the third party to
      // that agreement: what the route actually answers.
      it.each([
        ["zero events", [], 202],
        ["one event", [event({ id: "evt_corpus_1", journeyId: "jrn_corpus" })], 202],
        ["one hundred and one events", Array.from({ length: 101 }, () => event()), 400]
      ])("%s", async (_name, events, status) => {
        const response = await batch(events);
        expect(response.statusCode, response.body).toBe(status);
      });

      it("one hundred events", async () => {
        const response = await batch(
          Array.from({ length: 100 }, (_unused, index) =>
            event({ id: `evt_corpus_100_${String(index)}`, journeyId: "jrn_corpus_100" })
          )
        );
        expect(response.statusCode, response.body).toBe(202);
        expect(response.json().data.results.length).toBe(100);
      });

      it("an unknown extra field beside events is ignored", async () => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/events/batch",
          headers: { authorization: `Bearer ${apiKey}` },
          payload: {
            events: [event({ id: "evt_corpus_extra", journeyId: "jrn_corpus" })],
            tenantRegion: "eu-west-1"
          } as object
        });
        expect(response.statusCode, response.body).toBe(202);
      });

      it.each([
        ["events is not an array", { events: "one" }],
        ["a null body", null]
      ])("%s is a whole-request refusal", async (_name, payload) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/events/batch",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          payload: payload === null ? "null" : payload
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error.code).toBe("invalid_event");
      });
    });
  });
});
