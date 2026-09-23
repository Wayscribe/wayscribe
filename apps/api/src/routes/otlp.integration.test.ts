import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import protobuf from "protobufjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeOwnedTestResources,
  type OwnedTestResource
} from "../../test-support/owned-test-resources.js";
import { buildApp } from "../app.js";
import { descriptor } from "../otlp/schema/descriptor.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const adminToken = "admin-token-for-tests-0000000000";
const root = protobuf.Root.fromJSON(descriptor);
const requestType = root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"
);
const responseType = root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse"
);
const statusType = root.lookupType("google.rpc.Status");
function value(input: unknown): object {
  if (input === null) return {};
  if (typeof input === "string") return { stringValue: input };
  if (typeof input === "number") return { intValue: String(input) };
  if (typeof input === "boolean") return { boolValue: input };
  if (Array.isArray(input)) return { arrayValue: { values: input.map(value) } };
  return { kvlistValue: { values: attributes(input as Record<string, unknown>) } };
}
function attributes(input: Record<string, unknown>): object[] {
  return Object.entries(input).map(([key, one]) => ({ key, value: value(one) }));
}
function record(id: string, overrides: Record<string, unknown> = {}): object {
  return {
    timeUnixNano: "1786032000120000000",
    attributes: attributes({
      "wayscribe.event.id": id,
      "wayscribe.journey.id": `jrn_${id}`,
      "wayscribe.entity.type": "customer",
      "wayscribe.entity.id": "customer-42",
      "wayscribe.operation": "transformed",
      "wayscribe.name": "normalize",
      "wayscribe.aliases": { crm: `crm_${id}` },
      "wayscribe.input": { phone: "555-0100", password: "synthetic-secret" },
      "wayscribe.output": { phone: null, password: "synthetic-secret" },
      ...overrides
    })
  };
}
function body(records: object[], environment = "development"): object {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: attributes({
            "service.name": "otlp-test",
            "deployment.environment.name": environment
          })
        },
        scopeLogs: [{ logRecords: records }]
      }
    ]
  };
}

/** Async subprocess: receiver's event loop must remain available to the exporter. */
async function runExporter(python: string, endpoint: string, apiKey: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(python, ["examples/otlp-logs/export.py"], {
      env: { ...process.env, OTLP_EXAMPLE_ENDPOINT: endpoint, OTLP_EXAMPLE_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("exporter deadline exceeded");
      child.kill("SIGKILL");
    }, 30_000);
    const append = (chunk: Buffer): void => {
      if (failure !== undefined) return;
      if (output.length + chunk.length > 65_536) {
        failure = new Error("exporter output exceeded bound");
        child.kill("SIGKILL");
        return;
      }
      output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Exporter exit ${String(code)}: ${output}`));
      else resolve(output);
    });
  });
}

describe("OTLP real storage", () => {
  let db: Knex;
  let databaseUri: string;
  let app: FastifyInstance;
  let apiKey: string;
  let otherKey: string;
  let productionKey: string;
  let projectId: string;
  let environmentId: string;
  const logs: string[] = [];
  const owners: OwnedTestResource[] = [];
  const cleanup = async (): Promise<void> => {
    await closeOwnedTestResources(owners.splice(0).reverse());
  };
  beforeAll(async () => {
    try {
      const database = await startPostgres();
      owners.push({ name: "OTLP test database", close: () => database.stop() });
      databaseUri = database.getConnectionUri();
      db = knex(createKnexConfig(databaseUri));
      owners.push({ name: "OTLP Knex pool", close: () => db.destroy() });
      await db.migrate.latest();
      const seed = async (
        slug: string,
        environment: string,
        existing?: string
      ): Promise<{ key: string; project: string; environment: string }> => {
        const project = existing ?? (await insertReturningId(db, "projects", { name: slug, slug }));
        const environmentId = await insertReturningId(db, "environments", {
          project_id: project,
          name: environment
        });
        const generated = issueApiKey(keyring);
        await db("api_keys").insert({
          project_id: project,
          environment_id: environmentId,
          name: "otlp",
          key_prefix: generated.keyPrefix,
          key_hash: generated.verifier,
          key_hash_key_id: generated.keyHashKeyId
        });
        return { key: generated.apiKey, project, environment: environmentId };
      };
      const first = await seed("otlp", "development");
      apiKey = first.key;
      projectId = first.project;
      environmentId = first.environment;
      otherKey = (await seed("other", "development")).key;
      productionKey = (await seed("otlp", "production", projectId)).key;
      app = buildApp({
        db,
        keyring,
        adminToken,
        otlpLogsEnabled: true,
        otlpMaxRequestBytes: 32768,
        logLevel: "debug",
        logStream: {
          write: (line) => {
            logs.push(line);
          }
        }
      });
      owners.push({ name: "OTLP API", close: () => app.close() });
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "OTLP setup and cleanup failed");
      }
      throw error;
    }
  });
  afterAll(cleanup);
  const send = (payload: object, encoding = "json", coding = "identity", key = apiKey) => {
    const bytes =
      encoding === "json"
        ? Buffer.from(JSON.stringify(payload))
        : Buffer.from(requestType.encode(requestType.fromObject(payload)).finish());
    return app.inject({
      method: "POST",
      url: "/v1/logs",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": encoding === "json" ? "application/json" : "application/x-protobuf",
        "content-encoding": coding
      },
      payload: coding === "gzip" ? gzipSync(bytes) : bytes
    });
  };
  const get = (url: string, key = apiKey) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
  const count = async (): Promise<number> =>
    Number((await db("journey_events").count({ n: "*" }).first())?.n);

  it.each(["json", "protobuf"])(
    "stores %s identity/gzip, native queries show redaction and diffs",
    async (encoding) => {
      for (const coding of ["identity", "gzip"]) {
        const id = `evt_${encoding}_${coding}`;
        const response = await send(body([record(id)]), encoding, coding);
        expect(response.statusCode, response.body).toBe(200);
        const parsed =
          encoding === "json"
            ? response.json()
            : responseType.toObject(responseType.decode(response.rawPayload));
        expect(parsed).toEqual({});
        const detail = (await get(`/v1/events/${id}`)).json().data;
        expect(detail.inputPayload).toEqual({ phone: "555-0100", password: "[REDACTED]" });
        expect(detail.payloadDiff).toEqual({
          truncated: false,
          changes: [{ path: "phone", kind: "changed", before: "555-0100", after: null }]
        });
        expect((await get(`/v1/search?q=crm_${id}`)).json().data.items[0].journeyId).toBe(
          `jrn_${id}`
        );
        expect((await get(`/v1/events/${id}`, otherKey)).statusCode).toBe(404);
        expect((await get(`/v1/events/${id}`, productionKey)).statusCode).toBe(404);
      }
    }
  );
  it.each(["json", "protobuf"])(
    "refuses admin and revoked credentials for %s",
    async (encoding) => {
      const res = await send({}, encoding, "identity", adminToken);
      expect(res.statusCode).toBe(401);
      const parsed =
        encoding === "json" ? res.json() : statusType.toObject(statusType.decode(res.rawPayload));
      expect(parsed).toEqual({ code: 16, message: "Authentication required." });
      await db("api_keys")
        .where({ project_id: projectId, environment_id: environmentId })
        .update({ revoked_at: db.fn.now() });
      try {
        expect((await send({}, encoding)).statusCode).toBe(401);
      } finally {
        await db("api_keys")
          .where({ project_id: projectId, environment_id: environmentId })
          .update({ revoked_at: null });
      }
    }
  );
  it.each(["json", "protobuf"])(
    "checks whole %s export before writes; handles unknowns and empty",
    async (encoding) => {
      const before = await count();
      expect(
        (
          await send(
            body(Array.from({ length: 101 }, (_, i) => record(`over_${String(i)}`))),
            encoding
          )
        ).statusCode
      ).toBe(413);
      expect(await count()).toBe(before);
      expect((await send({ unknownFuture: "ignored", ...body([]) }, encoding)).statusCode).toBe(
        200
      );
      expect(await count()).toBe(before);
    }
  );
  it("malformed, deep, and over-limit exports leave zero records even with a valid prefix", async () => {
    const before = await count();
    const valid = Buffer.from(
      requestType.encode(requestType.fromObject(body([record("must_not_store")]))).finish()
    );
    const cases: [string, string, Buffer, number][] = [
      [
        "application/x-protobuf",
        "identity",
        Buffer.concat([valid, Buffer.from([0x0a, 0xff])]),
        400
      ],
      [
        "application/json",
        "identity",
        Buffer.from(JSON.stringify(body([record("must_not_store")])).slice(0, -1)),
        400
      ],
      [
        "application/json",
        "identity",
        Buffer.from('{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":true}]}]}]}'),
        400
      ],
      [
        "application/json",
        "identity",
        Buffer.from('{"unknown":' + "[".repeat(130) + "0" + "]".repeat(130) + "}"),
        413
      ],
      ["application/json", "gzip", gzipSync(Buffer.alloc(32769, 32)), 413],
      ["application/x-protobuf", "gzip", gzipSync(valid).subarray(0, -2), 400],
      ["application/x-protobuf", "gzip", Buffer.alloc(32769), 413],
      ["application/json", "identity", Buffer.alloc(32769), 413],
      ["application/json", "deflate", Buffer.from("{}"), 415],
      ["application/json", "br", Buffer.from("{}"), 415],
      // Another casing is not an empty export: 400, not 200 with nothing stored.
      [
        "application/json",
        "identity",
        Buffer.from(JSON.stringify({ resource_logs: [{ scope_logs: [{ log_records: [{}] }] }] })),
        400
      ],
      ["text/plain", "identity", Buffer.from("{}"), 415]
    ];
    for (const [type, coding, payload, status] of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/logs",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": type,
          "content-encoding": coding
        },
        payload
      });
      expect(res.statusCode, `${type} ${coding}`).toBe(status);
      expect(await count()).toBe(before);
    }
  });
  it("a permanent auth database error is 500, never retryable, invalid credentials or leaked SQL", async () => {
    await db.schema.renameTable("api_keys", "otlp_hidden_keys");
    try {
      const res = await send({});
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ code: 13, message: "OTLP ingestion failed." });
      expect(logs.join("")).not.toContain("otlp_hidden_keys");
      expect(logs.join("")).not.toContain("does not exist");
    } finally {
      await db.schema.renameTable("otlp_hidden_keys", "api_keys");
    }
  });
  it("same IDs in another project remain separate and environment ownership stays authoritative", async () => {
    const payload = body([record("scoped_same")]);
    expect((await send(payload)).statusCode).toBe(200);
    expect((await send(payload, "json", "identity", otherKey)).statusCode).toBe(200);
    expect(await db("journey_events").where({ id: "scoped_same" })).toHaveLength(2);
    const conflict = await send(
      body([record("scoped_prod", { "wayscribe.journey.id": "jrn_scoped_same" })], "production"),
      "json",
      "identity",
      productionKey
    );
    expect(conflict.json().partialSuccess.rejectedLogRecords).toBe("1");
    expect(await db("journey_events").where({ id: "scoped_prod" })).toHaveLength(0);
  });
  it("mixed permanent refusals include SQL text, conflicts, mapping, environment and exact count", async () => {
    const response = await send(
      body([
        record("mixed_ok"),
        record("mixed_bad", { "wayscribe.event.id": null }),
        record("mixed_poison", { "wayscribe.input": { text: "poison\u0000sentinel" } }),
        record("mixed_ok", { "wayscribe.name": "changed" }),
        record("mixed_last")
      ])
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      partialSuccess: {
        rejectedLogRecords: "3",
        errorMessage:
          "Rejected: invalid_attribute_type x1, unstorable_payload x1, event_id_conflict x1"
      }
    });
    expect(logs.join("")).toContain('"event_id_conflict":1');
    expect(
      await db("journey_events").whereIn("id", [
        "mixed_ok",
        "mixed_bad",
        "mixed_poison",
        "mixed_last"
      ])
    ).toHaveLength(2);
    const denied = await send(body([record("env_denied")], "production"));
    expect(denied.json().partialSuccess).toEqual({
      rejectedLogRecords: "1",
      errorMessage: "Rejected: unauthorized_environment x1"
    });
    expect(await db("journey_events").where({ id: "env_denied" })).toHaveLength(0);
    expect(logs.join("")).not.toContain("poison");
    expect(logs.join("")).not.toContain("synthetic-secret");
  });
  it("accepts stock OpenTelemetry records: key environment, log.record.uid, then a keyed content id", async () => {
    const stock = (extra: Record<string, unknown>): object => ({
      timeUnixNano: "1786032000120000123",
      observedTimeUnixNano: "1786032000130000000",
      severityNumber: 9,
      body: { stringValue: "customer normalized" },
      attributes: attributes({
        "wayscribe.journey.id": "jrn_stock",
        "wayscribe.entity.type": "customer",
        "wayscribe.entity.id": "customer-stock",
        "wayscribe.operation": "transformed",
        "wayscribe.name": "normalize",
        "wayscribe.input": { phone: "555-0100", password: "synthetic-secret" },
        "wayscribe.output": { phone: null },
        ...extra
      })
    });
    const payload = {
      resourceLogs: [
        {
          // No deployment.environment.name: the key's environment applies.
          resource: { attributes: attributes({ "service.name": "stock-otel" }) },
          scopeLogs: [
            {
              scope: { name: "io.example.customers" },
              logRecords: [
                stock({ "log.record.uid": "01JSTOCKUID00000000000000A" }),
                stock({ "http.request.method": "POST" })
              ]
            }
          ]
        }
      ]
    };
    for (const encoding of ["json", "protobuf"]) {
      const res = await send(payload, encoding);
      expect(res.statusCode, res.body).toBe(200);
    }
    const stored = await db("journey_events")
      .where({ journey_id: "jrn_stock" })
      .select("id", "environment_id")
      .orderBy("id");
    // Four sends across two encodings, two records: one row each.
    expect(stored).toHaveLength(2);
    expect(stored.map((row: { id: string }) => row.id)).toEqual([
      "01JSTOCKUID00000000000000A",
      expect.stringMatching(/^otlp_[0-9a-f]{64}$/)
    ]);
    for (const row of stored as { environment_id: string }[])
      expect(row.environment_id).toBe(environmentId);
    const hashed = (stored as { id: string }[])[1]?.id ?? "";
    const detail = (await get(`/v1/events/${hashed}`)).json().data;
    expect(detail.inputPayload).toEqual({ phone: "555-0100", password: "[REDACTED]" });
    expect(hashed).not.toContain("synthetic-secret");

    // A retry that straddles a key rotation finds the id its first attempt stored.
    const rotated = createKeyring(
      "fedcba9876543210fedcba9876543210",
      "0123456789abcdef0123456789abcdef"
    );
    const generated = issueApiKey(rotated);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "otlp-rotated",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    const rotatedApp = buildApp({
      db,
      keyring: rotated,
      adminToken,
      otlpLogsEnabled: true,
      logLevel: "silent"
    });
    try {
      const res = await rotatedApp.inject({
        method: "POST",
        url: "/v1/logs",
        headers: {
          authorization: `Bearer ${generated.apiKey}`,
          "content-type": "application/json"
        },
        payload
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({});
    } finally {
      await rotatedApp.close();
    }
    expect(await db("journey_events").where({ journey_id: "jrn_stock" })).toHaveLength(2);
  });
  it("503 after the first commit stops later records; identical retry has one row per stable ID", async () => {
    await db.raw(
      `CREATE FUNCTION otlp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'retry_second' THEN RAISE EXCEPTION 'private-database-sentinel' USING ERRCODE = '08006'; END IF; RETURN NEW; END $$`
    );
    await db.raw(
      "CREATE TRIGGER otlp_fail BEFORE INSERT ON journey_events FOR EACH ROW EXECUTE FUNCTION otlp_fail()"
    );
    const payload = body([record("retry_first"), record("retry_second"), record("retry_third")]);
    try {
      const res = await send(payload, "protobuf");
      expect(res.statusCode).toBe(503);
      expect(statusType.toObject(statusType.decode(res.rawPayload))).toEqual({
        code: 14,
        message: "OTLP ingestion unavailable."
      });
      expect(
        await db("journey_events")
          .whereIn("id", ["retry_first", "retry_second", "retry_third"])
          .pluck("id")
      ).toEqual(["retry_first"]);
    } finally {
      await db.raw("DROP TRIGGER otlp_fail ON journey_events");
      await db.raw("DROP FUNCTION otlp_fail()");
    }
    expect((await send(payload, "protobuf")).statusCode).toBe(200);
    expect(
      await db("journey_events").whereIn("id", ["retry_first", "retry_second", "retry_third"])
    ).toHaveLength(3);
    expect(await db("journeys").where({ id: "jrn_retry_first" }).first()).toMatchObject({
      event_count: 1
    });
    expect(logs.join("")).not.toContain("private-database-sentinel");
    const metrics = await app.metrics.render();
    expect(metrics).toMatch(/wayscribe_events_total\{result="duplicate"\} [1-9]/);
    expect(metrics).toMatch(/wayscribe_events_total\{result="rejected"\} [1-9]/);
    expect(metrics).toContain('route="/v1/logs"');
    expect(metrics).not.toContain("retry_first");
  });
  it("actual statement timeout is transient and counted safely", async () => {
    await db.raw(
      `CREATE FUNCTION otlp_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`
    );
    await db.raw(
      "CREATE TRIGGER otlp_slow BEFORE INSERT ON journey_events FOR EACH ROW EXECUTE FUNCTION otlp_slow()"
    );
    const temporary: OwnedTestResource[] = [];
    let timeoutApp: FastifyInstance;
    try {
      const slowDb = knex(createKnexConfig(databaseUri, { statementTimeoutMs: 30 }));
      temporary.push({ name: "timeout pool", close: () => slowDb.destroy() });
      timeoutApp = buildApp({
        db: slowDb,
        keyring,
        adminToken,
        otlpLogsEnabled: true,
        logLevel: "silent"
      });
      temporary.push({ name: "timeout app", close: () => timeoutApp.close() });
      const res = await timeoutApp.inject({
        method: "POST",
        url: "/v1/logs",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        payload: body([record("timeout_event")])
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ code: 14, message: "OTLP ingestion unavailable." });
      expect(await db("journey_events").where({ id: "timeout_event" })).toHaveLength(0);
      expect(await timeoutApp.metrics.render()).toContain(
        'wayscribe_query_timeouts_total{route="/v1/logs"} 1'
      );
    } finally {
      await closeOwnedTestResources([
        ...temporary.reverse(),
        {
          name: "timeout trigger",
          close: async () => {
            await db.raw("DROP TRIGGER otlp_slow ON journey_events");
            await db.raw("DROP FUNCTION otlp_slow()");
          }
        }
      ]);
    }
  });
  it("full capture requires server opt-in and native ingestion/parser remain isolated", async () => {
    await db("environments").where({ id: environmentId }).update({ capture_mode: "full-payload" });
    try {
      expect(
        (
          await send(
            body([
              record("full_off", {
                "wayscribe.error": { type: "Example", message: "failure", stack: "safe-stack" }
              })
            ])
          )
        ).statusCode
      ).toBe(200);
      expect((await get("/v1/events/full_off")).json().data.error.stack).toBeUndefined();
      const enabled = buildApp({
        db,
        keyring,
        adminToken,
        otlpLogsEnabled: true,
        allowFullPayloadCapture: true,
        logLevel: "silent"
      });
      try {
        expect(
          (
            await enabled.inject({
              method: "POST",
              url: "/v1/logs",
              headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
              payload: body([
                record("full_on", {
                  "wayscribe.error": { type: "Example", message: "failure", stack: "safe-stack" }
                })
              ])
            })
          ).statusCode
        ).toBe(200);
        expect((await get("/v1/events/full_on")).json().data.error.stack).toBe("safe-stack");
      } finally {
        await enabled.close();
      }
    } finally {
      await db("environments")
        .where({ id: environmentId })
        .update({ capture_mode: "redacted-payload" });
    }
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "application/json" },
      payload: "{"
    });
    expect(malformed.json().error.code).toBe("malformed_json");
    const native = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id: "native_alive",
          journeyId: "native_alive",
          environment: "development",
          service: "native",
          entity: { type: "customer", id: "42" },
          operation: "received",
          name: "native",
          timestamp: "2026-08-06T00:00:00.000Z"
        }
      }
    });
    expect(native.statusCode).toBe(202);
  });
  it.runIf(process.env.OTLP_EXPORTER_PYTHON)(
    "official Python exporter proves loopback journey, alias, diff and retry",
    async () => {
      const python = process.env.OTLP_EXPORTER_PYTHON;
      if (python === undefined) throw new Error("missing exporter Python");
      const address = app.server.address();
      if (address === null || typeof address === "string")
        throw new Error("missing loopback listener");
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = await runExporter(
          python,
          `http://127.0.0.1:${String(address.port)}/v1/logs`,
          apiKey
        );
        expect(output).toContain("official exporter=1.44.0 sdk=1.44.0 flushed 2 annotated records");
        expect(output).not.toContain("Failed");
        console.info(output.trim());
      }
      expect((await get("/v1/search?q=crm-otlp-9001")).json().data.items[0].journeyId).toBe(
        "jrn_otlp_official"
      );
      expect((await get("/v1/journeys/jrn_otlp_official")).json().data).toMatchObject({
        journeyId: "jrn_otlp_official",
        status: "failed"
      });
      expect((await get("/v1/journeys/jrn_otlp_official/events")).json().data.items).toHaveLength(
        2
      );
      const detail = (await get("/v1/events/evt_otlp_official_transform")).json().data;
      expect(detail.inputPayload).toEqual({ phone: "555-0100", password: "[REDACTED]" });
      expect(detail.payloadDiff.changes).toEqual([
        { path: "phone", kind: "changed", before: "555-0100", after: null }
      ]);
      expect(detail.error).toBeNull(); // severity ERROR is not a business failure
      expect(await db("journey_events").where({ journey_id: "jrn_otlp_official" })).toHaveLength(2);
    }
  );
  it("valid OTLP ingestion bypasses an already locked admin address", async () => {
    for (let i = 0; i < 5; i++) await get("/v1/projects", "wrong-admin");
    expect((await get("/v1/projects", adminToken)).statusCode).toBe(429);
    expect((await send(body([record("after_admin_lock")]))).statusCode).toBe(200);
  });
});
