import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, listAudit } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyring = createKeyring(KEY_A);
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

describe("replay routes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let target: Server;
  let targetPort: number;
  /** Requests the target has received, so a refusal can be shown to send nothing. */
  let targetRequests = 0;
  /** The headers of the last request the target received, to show what went out. */
  let targetHeaders: Record<string, string | string[] | undefined> = {};
  let projectId: string;
  let apiKey: string;
  let eventWithInput: string;
  let eventWithoutInput: string;

  beforeAll(async () => {
    target = createServer((request, response) => {
      targetRequests += 1;
      targetHeaders = request.headers;
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        // A development endpoint that echoes what it received, as debugging
        // endpoints and error pages often do, in JSON and as plain text.
        if (request.url === "/echo/json") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ received: { headers: request.headers } }));
          return;
        }
        if (request.url === "/echo/text") {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end(
            Object.entries(request.headers)
              .map(([name, value]) => `${name}: ${String(value)}`)
              .join("\n")
          );
          return;
        }
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

  it("refuses to replay without headers it can no longer decrypt, and records why", async () => {
    // The destination's credential was encrypted under A. After A is removed,
    // replaying without it would send the recorded input unauthenticated, or
    // with whatever a gateway does for anonymous callers. Refusing says what to
    // fix; sending silently would look like the destination had broken.
    const created = await app.inject({
      method: "POST",
      url: "/v1/replay-destinations",
      headers: admin(),
      payload: {
        name: "credentialed",
        baseUrl: `http://localhost:${String(targetPort)}`,
        environmentType: "development",
        headers: { authorization: "Bearer destination-credential" }
      }
    });
    const destinationId = created.json<{ data: { id: string } }>().data.id;

    const logLines: string[] = [];
    const afterRemoval = buildApp({
      db,
      keyring: createKeyring(KEY_B),
      adminToken: ADMIN_TOKEN,
      logLevel: "warn",
      logStream: { write: (line: string) => logLines.push(line) },
      replayAllowedHosts: ["localhost"]
    });
    const before = targetRequests;
    try {
      const response = await afterRemoval.inject({
        method: "POST",
        url: "/v1/replays",
        headers: admin(),
        payload: { eventId: eventWithInput, destinationId, path: "/replay/customer" }
      });

      expect(response.statusCode).toBe(422);
      const data = response.json<{
        data: { id: string; status: string; error: { reason: string; message: string } };
      }>().data;
      expect(data.status).toBe("blocked");
      expect(data.error.reason).toBe("headers_key_not_configured");
      expect(data.error.message).toContain(keyring.current.id);
      expect(data.error.message).toContain("ENCRYPTION_KEY_PREVIOUS");
      expect(targetRequests).toBe(before);

      const audit = await listAudit(db, projectId);
      const entry = audit.find(
        (item) => item.action === "replay.blocked" && item.resourceId === data.id
      );
      expect(entry?.metadata).toMatchObject({ reason: "headers_key_not_configured" });

      // The operator learns of the missing key from the log too, once per key
      // id however many replays meet it, and never with the credential.
      await afterRemoval.inject({
        method: "POST",
        url: "/v1/replays",
        headers: admin(),
        payload: { eventId: eventWithInput, destinationId, path: "/replay/customer" }
      });
      const warnings = logLines
        .map((line) => JSON.parse(line) as { level: number; keyId?: string })
        .filter((line) => line.level === 40 && line.keyId !== undefined);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.keyId).toBe(keyring.current.id);
      expect(logLines.join("")).not.toContain("destination-credential");
    } finally {
      await afterRemoval.close();
    }
  });

  it("never stores or returns a destination header's value, and still sends it", async () => {
    // Destination headers are encrypted at rest because they are credentials.
    // A run row is plain jsonb, read back by the API and kept until retention,
    // so copying the decrypted value into it would undo that encryption.
    const secret = "dst-secret-7f3a9c1e5b";
    const created = await app.inject({
      method: "POST",
      url: "/v1/replay-destinations",
      headers: admin(),
      payload: {
        name: "header storage",
        baseUrl: `http://localhost:${String(targetPort)}`,
        environmentType: "development",
        headers: { "X-Dev-Token": secret, authorization: `Bearer ${secret}` }
      }
    });
    expect(created.statusCode).toBe(201);
    const destinationId = created.json<{ data: { id: string } }>().data.id;

    const replayed = await app.inject({
      method: "POST",
      url: "/v1/replays",
      headers: admin(),
      payload: { eventId: eventWithInput, destinationId, path: "/replay/customer" }
    });
    expect(replayed.statusCode).toBe(200);
    const runId = replayed.json<{ data: { id: string; status: string } }>().data.id;
    expect(replayed.body).not.toContain(secret);

    // The destination received the real values: redaction is of the record only.
    expect(targetHeaders["x-dev-token"]).toBe(secret);
    expect(targetHeaders["authorization"]).toBe(`Bearer ${secret}`);

    const row: unknown = await db("replay_runs")
      .where({ id: runId })
      .first("request_headers as requestHeaders");
    const stored = (row as { requestHeaders: Record<string, string> } | undefined)?.requestHeaders;
    expect(JSON.stringify(stored)).not.toContain(secret);
    // Names stay, so an operator can see which headers were sent.
    expect(stored).toMatchObject({
      "x-dev-token": "[REDACTED]",
      authorization: "[REDACTED]",
      "x-flight-replay": "true",
      "user-agent": "flight-recorder-replay"
    });

    const read = await app.inject({
      method: "GET",
      url: `/v1/replays/${runId}`,
      headers: admin()
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(secret);
    const readHeaders = read.json<{ data: { requestHeaders: Record<string, string> } }>().data
      .requestHeaders;
    expect(readHeaders["x-dev-token"]).toBe("[REDACTED]");
    expect(readHeaders["authorization"]).toBe("[REDACTED]");

    // Nor does the audit trail, which is never swept.
    const audit = await listAudit(db, projectId, 500);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(await db("replay_runs").select())).not.toContain(secret);
  });

  it.each([
    ["JSON", "/echo/json"],
    ["text", "/echo/text"]
  ])(
    "never stores or returns a destination header value a %s response echoes",
    async (_form, path) => {
      // The request headers are redacted before storage, but a destination that
      // echoes its request would put the credential straight back into the
      // stored response, and from there into both API responses.
      const secret = `echo-secret-${path.replaceAll("/", "-")}-91b2`;
      const created = await app.inject({
        method: "POST",
        url: "/v1/replay-destinations",
        headers: admin(),
        payload: {
          name: `echo ${path}`,
          baseUrl: `http://localhost:${String(targetPort)}`,
          environmentType: "development",
          // Inside a longer value too: a Bearer prefix must not shield it.
          headers: { "x-dev-token": secret, authorization: `Bearer ${secret}` }
        }
      });
      expect(created.statusCode).toBe(201);
      const destinationId = created.json<{ data: { id: string } }>().data.id;

      const replayed = await app.inject({
        method: "POST",
        url: "/v1/replays",
        headers: admin(),
        payload: { eventId: eventWithInput, destinationId, path }
      });
      expect(replayed.statusCode).toBe(200);
      expect(targetHeaders["x-dev-token"]).toBe(secret);
      expect(replayed.body).not.toContain(secret);
      const runId = replayed.json<{ data: { id: string } }>().data.id;

      const row: unknown = await db("replay_runs").where({ id: runId }).first();
      expect(JSON.stringify(row)).not.toContain(secret);

      const read = await app.inject({
        method: "GET",
        url: `/v1/replays/${runId}`,
        headers: admin()
      });
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain(secret);
      // The echo is still there to read, with the header's name and a marker.
      const echoed = JSON.stringify(
        read.json<{ data: { responsePayload: unknown } }>().data.responsePayload
      );
      expect(echoed).toContain("x-dev-token");
      expect(echoed).toContain("[REDACTED]");
    }
  );

  it("writes an audit entry for a successful replay", async () => {
    const audit = await listAudit(db, projectId);
    expect(audit.some((entry) => entry.action === "replay.completed")).toBe(true);
    expect(audit.some((entry) => entry.action === "replay_destination.created")).toBe(true);
  });

  it("records a destination's creation by name, without its base URL", async () => {
    // A base URL can carry credentials or an internal hostname, audit rows are
    // never swept, and deleting the destination cannot reach its audit row.
    const baseUrl = "http://user:secret@build-box.internal.example:3200/base";
    const destinationId = await makeDestination(baseUrl, "audited without its url");

    const entry = (await listAudit(db, projectId, 500)).find(
      (candidate) =>
        candidate.action === "replay_destination.created" && candidate.resourceId === destinationId
    );
    expect(entry?.metadata).toEqual({ name: "audited without its url" });
    expect(JSON.stringify(entry)).not.toContain("build-box.internal.example");
    expect(JSON.stringify(entry)).not.toContain("secret");
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
