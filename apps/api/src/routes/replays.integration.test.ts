import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, listAudit } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

describe("replay routes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let target: Server;
  let targetPort: number;
  let projectId: string;
  let apiKey: string;
  let eventWithInput: string;
  let eventWithoutInput: string;

  beforeAll(async () => {
    target = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const payload = JSON.parse(body || "null") as { Phone?: string };
        response.writeHead(200, { "content-type": "application/json" });
        // The corrected mapping: reads `Phone`, which is what arrives.
        response.end(JSON.stringify({ name: "Jorge Polanco", phone: payload.Phone ?? null }));
      });
    });
    await new Promise<void>((resolve) => {
      target.listen(0, "127.0.0.1", resolve);
    });
    targetPort = (target.address() as AddressInfo).port;

    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "R", slug: "r" });
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

    await db("journeys").insert({
      id: "jrn_r",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "h",
      status: "failed",
      started_at: db.fn.now(),
      last_event_at: db.fn.now(),
      event_count: 2
    });

    const event = async (id: string, input: unknown, output: unknown): Promise<string> => {
      await db("journey_events").insert({
        id,
        project_id: projectId,
        environment_id: environmentId,
        journey_id: "jrn_r",
        service: "svc",
        operation: "transformed",
        name: "transform",
        event_timestamp: db.fn.now(),
        protocol_version: "0.1",
        content_hash: id,
        input_payload: input === undefined ? null : JSON.stringify(input),
        output_payload: output === undefined ? null : JSON.stringify(output)
      });
      return id;
    };

    eventWithInput = await event(
      "evt_with_input",
      { Phone: "+1 919 555 1234", Name: "Jorge Polanco" },
      { name: "Jorge Polanco", phone: null }
    );
    eventWithoutInput = await event("evt_no_input", undefined, undefined);

    app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "silent",
      replayAllowedHosts: ["localhost"]
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
    await new Promise<void>((resolve) => {
      target.close(() => {
        resolve();
      });
    });
  });

  // The project is always named. Relying on the "only project" fallback would
  // make every test after the isolation case fail, which is the behaviour the
  // interface hit in production and the reason it now names one too.
  const admin = (): Record<string, string> => ({
    authorization: `Bearer ${ADMIN_TOKEN}`,
    "x-flight-project-id": projectId
  });

  async function makeDestination(baseUrl: string, name: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/replay-destinations",
      headers: admin(),
      payload: { name, baseUrl, environmentType: "development" }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ data: { id: string } }>().data.id;
  }

  it("refuses an API key", async () => {
    // ADR-032. A key sits in application configuration on servers many people
    // can reach; letting it drive outbound requests would turn a leaked
    // telemetry key into a request-forgery primitive.
    const response = await app.inject({
      method: "GET",
      url: "/v1/replay-destinations",
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a production-ish environment type", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/replay-destinations",
      headers: admin(),
      payload: { name: "prod", baseUrl: "http://localhost:1", environmentType: "production" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_environment_type"
    );
  });

  it("replays a recorded input and compares the result", async () => {
    const destinationId = await makeDestination(
      `http://localhost:${String(targetPort)}`,
      "corrected"
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/replays",
      headers: admin(),
      payload: { eventId: eventWithInput, destinationId, path: "/replay/customer" }
    });

    expect(response.statusCode).toBe(200);
    const data = response.json<{
      data: {
        status: string;
        responseStatus: number;
        responsePayload: { phone: string };
        comparison: { changes: { path: string; before?: unknown; after?: unknown }[] };
      };
    }>().data;

    expect(data.status).toBe("completed");
    expect(data.responseStatus).toBe(200);
    // The whole point of replay: the corrected endpoint keeps the phone number.
    expect(data.responsePayload.phone).toBe("+1 919 555 1234");

    // And the comparison shows it against what was originally recorded. Both
    // sides share a shape here, which the transformation diff could not (ADR-030).
    const phone = data.comparison.changes.find((change) => change.path === "phone");
    expect(phone?.before).toBeNull();
    expect(phone?.after).toBe("+1 919 555 1234");
  });

  it("refuses an event with no captured input", async () => {
    const destinationId = await makeDestination(
      `http://localhost:${String(targetPort)}`,
      "no-input-check"
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/replays",
      headers: admin(),
      payload: { eventId: eventWithoutInput, destinationId, path: "/x" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("no_captured_input");
  });

  it("blocks a destination outside the allowlist and records why", async () => {
    const destinationId = await makeDestination("http://evil.example.com", "not-allowed");
    const response = await app.inject({
      method: "POST",
      url: "/v1/replays",
      headers: admin(),
      payload: { eventId: eventWithInput, destinationId, path: "/steal" }
    });

    expect(response.statusCode).toBe(422);
    const data = response.json<{ data: { status: string; error: { reason: string } } }>().data;
    expect(data.status).toBe("blocked");
    expect(data.error.reason).toBe("host_not_allowed");

    // A blocked attempt leaves both a run and an audit entry. Without the row,
    // the safety checks would be invisible to whoever has to explain them.
    const audit = await listAudit(db, projectId);
    expect(audit.some((entry) => entry.action === "replay.blocked")).toBe(true);
  });

  it("writes an audit entry for a successful replay", async () => {
    const audit = await listAudit(db, projectId);
    expect(audit.some((entry) => entry.action === "replay.completed")).toBe(true);
    expect(audit.some((entry) => entry.action === "replay_destination.created")).toBe(true);
  });

  it("does not return another project's replay", async () => {
    const otherProject = await insertReturningId(db, "projects", { name: "O", slug: "o" });
    const destinationId = await makeDestination(
      `http://localhost:${String(targetPort)}`,
      "isolation"
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/replays",
      headers: admin(),
      payload: { eventId: eventWithInput, destinationId, path: "/replay/customer" }
    });
    const runId = created.json<{ data: { id: string } }>().data.id;

    const response = await app.inject({
      method: "GET",
      url: `/v1/replays/${runId}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-flight-project-id": otherProject }
    });
    expect(response.statusCode).toBe(404);
  });
});
