import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKeyring, parseEncryptedValue } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "../knex-config.js";
import { insertReturningId } from "../insert.js";
import { listAudit, recordAudit } from "./audit.js";
import {
  createDestination,
  destinationHeaders,
  findDestination,
  findRun,
  finishRun,
  listDestinations,
  startRun
} from "./replay.js";

/** The key id a stored value names, or null for a legacy value. */
const keyIdOf = (value: string): string | null => {
  const parsed = parseEncryptedValue(value);
  return parsed.kind === "envelope" ? parsed.keyId : null;
};

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyring = createKeyring(KEY_A);

describe("replay destinations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
    projectB = await insertReturningId(db, "projects", { name: "B", slug: "b" });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("creates and reads back a destination", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "local integration",
      baseUrl: "http://localhost:3200",
      environmentType: "development"
    });

    expect(created.baseUrl).toBe("http://localhost:3200");
    expect(await findDestination(db, projectA, created.id)).toEqual(created);
  });

  it("never returns configured headers in a read", async () => {
    // A destination's credential is a real secret and the row is read by every
    // list call. It comes back only when a caller asks for it by name.
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "with credential",
      baseUrl: "http://localhost:3201",
      environmentType: "test",
      headers: { authorization: "Bearer development-only-token" }
    });

    const read = await findDestination(db, projectA, created.id);
    expect(JSON.stringify(read)).not.toContain("development-only-token");
    expect(JSON.stringify(await listDestinations(db, projectA))).not.toContain(
      "development-only-token"
    );

    expect(await destinationHeaders(db, keyring, projectA, created.id)).toEqual({
      ok: true,
      headers: { authorization: "Bearer development-only-token" }
    });
  });

  it("stores headers encrypted rather than in the clear", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "encrypted check",
      baseUrl: "http://localhost:3202",
      environmentType: "local",
      headers: { "x-test-secret": "plaintext-would-be-here" }
    });

    const raw: unknown = await db("replay_destinations")
      .where({ id: created.id })
      .first("encrypted_headers");
    expect((raw as { encrypted_headers: string }).encrypted_headers).not.toContain(
      "plaintext-would-be-here"
    );
  });

  it("reports headers under a key that is no longer configured, naming the key", async () => {
    // It used to degrade to no headers, and the replay went out without its
    // credentials. The caller has to be able to refuse instead.
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "rotated",
      baseUrl: "http://localhost:3203",
      environmentType: "local",
      headers: { "x-test-secret": "value" }
    });

    expect(await destinationHeaders(db, createKeyring(KEY_B), projectA, created.id)).toEqual({
      ok: false,
      reason: "headers_key_not_configured",
      keyId: keyring.current.id
    });
  });

  it("reports headers that do not decrypt under any configured key", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "corrupt",
      baseUrl: "http://localhost:3207",
      environmentType: "local",
      headers: { "x-test-secret": "value" }
    });
    const row: unknown = await db("replay_destinations")
      .where({ id: created.id })
      .first("encrypted_headers");
    const stored = row as { encrypted_headers: string };
    // Change one base64 character inside the payload: the key id still matches
    // a configured key, and GCM authentication then fails.
    const at = "fr1.".length + 13 + 20;
    const original = stored.encrypted_headers.charAt(at);
    const tampered = `${stored.encrypted_headers.slice(0, at)}${original === "A" ? "B" : "A"}${stored.encrypted_headers.slice(at + 1)}`;
    await db("replay_destinations")
      .where({ id: created.id })
      .update({ encrypted_headers: tampered });

    expect(await destinationHeaders(db, keyring, projectA, created.id)).toEqual({
      ok: false,
      reason: "headers_unreadable"
    });
  });

  it("reports no headers as an empty set, not a failure", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "no headers",
      baseUrl: "http://localhost:3208",
      environmentType: "local"
    });
    expect(await destinationHeaders(db, createKeyring(KEY_B), projectA, created.id)).toEqual({
      ok: true,
      headers: {}
    });
  });

  it("labels stored headers with the current key's id", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "labelled",
      baseUrl: "http://localhost:3205",
      environmentType: "local",
      headers: { "x-test-secret": "value" }
    });
    const raw = await db("replay_destinations")
      .where({ id: created.id })
      .first("encrypted_headers");
    expect(keyIdOf(raw.encrypted_headers)).toBe(keyring.current.id);
  });

  it("reads headers written under the previous key during a rotation", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "written before rotation",
      baseUrl: "http://localhost:3206",
      environmentType: "local",
      headers: { authorization: "Bearer before-rotation" }
    });
    expect(await destinationHeaders(db, createKeyring(KEY_B, KEY_A), projectA, created.id)).toEqual(
      { ok: true, headers: { authorization: "Bearer before-rotation" } }
    );
  });

  it("does not leak a destination across projects", async () => {
    const created = await createDestination(db, keyring, {
      projectId: projectA,
      name: "project a only",
      baseUrl: "http://localhost:3204",
      environmentType: "development"
    });

    expect(await findDestination(db, projectB, created.id)).toBeUndefined();
    expect((await listDestinations(db, projectB)).map((d) => d.id)).not.toContain(created.id);
  });
});

describe("replay runs", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let destinationId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "R", slug: "r" });

    // replay_runs carries a composite foreign key to (project_id,
    // journey_event_id), so a run cannot reference an event from another
    // project — the same structural guarantee the rest of the schema uses.
    // That means the fixture needs a real journey and a real event.
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    await db("journeys").insert({
      id: "jrn_replay_fixture",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "fixture-hash",
      status: "completed",
      started_at: db.fn.now(),
      last_event_at: db.fn.now(),
      event_count: 1
    });
    await db("journey_events").insert({
      id: "evt_1",
      project_id: projectId,
      environment_id: environmentId,
      journey_id: "jrn_replay_fixture",
      service: "svc",
      operation: "received",
      name: "receive",
      event_timestamp: db.fn.now(),
      protocol_version: "0.1",
      content_hash: "fixture-content-hash"
    });

    destinationId = (
      await createDestination(db, keyring, {
        projectId,
        name: "d",
        baseUrl: "http://localhost:3200",
        environmentType: "development"
      })
    ).id;
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const start = (): Promise<string> =>
    startRun(db, {
      projectId,
      journeyEventId: "evt_1",
      destinationId,
      method: "POST",
      requestPath: "/replay/customer",
      requestPayload: { externalId: "ACCT-1" },
      requestHeaders: { "content-type": "application/json" },
      initiatedBy: "admin"
    });

  it("records the attempt before the result exists", async () => {
    const id = await start();
    const run = await findRun(db, projectId, id);
    // Written first so a refusal still leaves a row. A blocked attempt that
    // persisted nothing would make the safety checks invisible.
    expect(run?.status).toBe("running");
    expect(run?.responseStatus).toBeNull();
    expect(run?.requestPayload).toEqual({ externalId: "ACCT-1" });
  });

  it("completes a run with its response", async () => {
    const id = await start();
    await finishRun(db, projectId, id, {
      status: "completed",
      responseStatus: 201,
      responsePayload: { id: "crm_1" },
      durationMs: 42
    });

    const run = await findRun(db, projectId, id);
    expect(run?.status).toBe("completed");
    expect(run?.responseStatus).toBe(201);
    expect(run?.responsePayload).toEqual({ id: "crm_1" });
    expect(run?.completedAt).not.toBeNull();
  });

  it("stores a blocked attempt with its reason", async () => {
    const id = await start();
    await finishRun(db, projectId, id, {
      status: "blocked",
      error: { reason: "host_not_allowed", message: "Host evil.example.com is not allowed." }
    });

    const run = await findRun(db, projectId, id);
    expect(run?.status).toBe("blocked");
    expect(JSON.stringify(run?.error)).toContain("host_not_allowed");
  });
});

describe("audit events", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "Au", slug: "au" });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("records an entry", async () => {
    await recordAudit(db, {
      projectId,
      actor: "admin",
      action: "replay.created",
      resourceType: "replay_run",
      resourceId: "run-1",
      metadata: { destination: "local integration" }
    });

    const [entry] = await listAudit(db, projectId);
    expect(entry?.action).toBe("replay.created");
    expect(entry?.resourceId).toBe("run-1");
  });

  it("redacts secrets out of metadata before storing them", async () => {
    // An audit trail that captures the thing it was auditing turns the safety
    // record into a second copy of the secret, in a table nobody thinks of as
    // sensitive.
    await recordAudit(db, {
      projectId,
      actor: "admin",
      action: "replay.blocked",
      resourceType: "replay_run",
      metadata: { authorization: "Bearer super-secret-value", reason: "host_not_allowed" }
    });

    const entries = await listAudit(db, projectId);
    const written = JSON.stringify(entries);
    expect(written).not.toContain("super-secret-value");
    // The rest survives: this is redaction, not suppression.
    expect(written).toContain("host_not_allowed");
  });

  it("returns the most recent first", async () => {
    await recordAudit(db, {
      projectId,
      actor: "admin",
      action: "replay.newest",
      resourceType: "replay_run"
    });
    expect((await listAudit(db, projectId))[0]?.action).toBe("replay.newest");
  });
});
