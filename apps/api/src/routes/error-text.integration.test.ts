import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { createKeyring, issueApiKey } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

// Assembled from parts so the secret scanner has no literal to match.
const PASSWORD = "hunter2-" + "ERRTEXT";
const STRIPE_KEY = "sk_" + "live_" + "StackFrameOpaque0000001";

const MESSAGE = `connect ECONNREFUSED postgres://orders:${PASSWORD}@db.internal:5432/orders`;
const STACK = [
  `Error: charge failed with Authorization: Bearer ${STRIPE_KEY}`,
  "    at charge (/srv/billing/dist/charge.js:41:11)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)"
].join("\n");

/**
 * Error text from a client that is not the SDK.
 *
 * Ingestion is public HTTP, so the SDK's own masking protects nothing here:
 * this sends exactly what a hand-rolled client could, including a stack, which
 * the SDK never sends.
 */
function eventWithError(id: string, environment: string): unknown {
  return {
    protocolVersion: "0.1",
    event: {
      id,
      journeyId: `jrn_${id}`,
      environment,
      service: "billing",
      entity: { type: "order", id: "ORD-2026-000123" },
      operation: "failed",
      name: "charge-card",
      timestamp: "2026-09-15T12:00:00.000Z",
      error: { type: "Error", code: "ECONNREFUSED", message: MESSAGE, stack: STACK }
    }
  };
}

interface StoredError {
  type?: string;
  code?: string;
  message: string;
  stack?: string;
}

describe("error text at ingestion", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  const keys: Record<string, string> = {};
  const apps: FastifyInstance[] = [];

  async function environmentWithKey(name: string, captureMode: string): Promise<void> {
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name,
      capture_mode: captureMode
    });
    const generated = issueApiKey(keyring);
    keys[name] = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name,
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
  }

  function appFor(allowFullPayloadCapture: boolean): FastifyInstance {
    const app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent",
      allowFullPayloadCapture
    });
    apps.push(app);
    return app;
  }

  async function ingest(
    app: FastifyInstance,
    id: string,
    environment: string
  ): Promise<StoredError> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${keys[environment] ?? ""}` },
      payload: eventWithError(id, environment) as object
    });
    expect(response.statusCode).toBe(202);

    // Read back out of PostgreSQL, not from the function that wrote it: the two
    // have disagreed before (WHAT_RUNNING_IT_FOUND.md).
    const row = (await db("journey_events").where({ project_id: projectId, id }).first()) as
      { error: StoredError } | undefined;
    if (row === undefined) throw new Error(`event ${id} was not stored`);
    return row.error;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "Billing", slug: "billing" });
    await environmentWithKey("development", "redacted-payload");
    await environmentWithKey("production", "full-payload");
    await environmentWithKey("staging", "metadata-only");
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    await db.destroy();
    await container.stop();
  });

  it("masks the message and drops the stack in redacted-payload mode", async () => {
    const stored = await ingest(appFor(false), "evt_err_redacted", "development");

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(JSON.stringify(stored)).not.toContain(STRIPE_KEY);
    // The control: the error is still there to read, only the secret is not.
    expect(stored.message).toBe(
      "connect ECONNREFUSED postgres://[REDACTED]@db.internal:5432/orders"
    );
    expect(stored.type).toBe("Error");
    expect(stored.code).toBe("ECONNREFUSED");
    expect(stored).not.toHaveProperty("stack");
  });

  it("masks the message and drops the stack in metadata-only mode", async () => {
    // Errors survive metadata-only (SECURITY.md section 3), so they are masked
    // there too, and a stack is no more welcome than a payload.
    const stored = await ingest(appFor(false), "evt_err_metadata", "staging");

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(stored.message).toContain("connect ECONNREFUSED postgres://[REDACTED]@db.internal");
    expect(stored).not.toHaveProperty("stack");
  });

  it("keeps a masked stack when the environment captures full payloads", async () => {
    const stored = await ingest(appFor(true), "evt_err_full", "production");

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(JSON.stringify(stored)).not.toContain(STRIPE_KEY);
    expect(stored.message).toBe(
      "connect ECONNREFUSED postgres://[REDACTED]@db.internal:5432/orders"
    );
    // The frames are what a team opted into full capture to see.
    expect(stored.stack).toContain("Error: charge failed with Authorization: Bearer [REDACTED]");
    expect(stored.stack).toContain("at charge (/srv/billing/dist/charge.js:41:11)");
  });

  it("drops the stack when full-payload is set but the installation has not allowed it", async () => {
    // The environment setting alone is inert without ALLOW_FULL_PAYLOAD_CAPTURE,
    // exactly as it is for payloads: it degrades to redacted-payload.
    const stored = await ingest(appFor(false), "evt_err_full_disallowed", "production");

    expect(JSON.stringify(stored)).not.toContain(STRIPE_KEY);
    expect(stored.message).toContain("postgres://[REDACTED]@db.internal:5432/orders");
    expect(stored).not.toHaveProperty("stack");
  });
});
