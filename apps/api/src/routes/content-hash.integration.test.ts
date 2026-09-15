import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import {
  createKeyring,
  issueApiKey,
  legacyContentHash,
  type Keyring
} from "@flight-recorder/payload-security";
import { parseEnvelope } from "@flight-recorder/protocol";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

const keyringA = createKeyring(KEY_A);
const rotated = createKeyring(KEY_B, KEY_A);
const keyringB = createKeyring(KEY_B);

/** The error message the security review recovered a password from. */
const connectionError = (password: string): string =>
  `connect ECONNREFUSED postgres://app:${password}@db.internal:5432/orders`;

function body(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: "0.1",
    event: {
      id,
      journeyId: `jrn_${id}`,
      environment: "development",
      service: "oracle",
      entity: { type: "customer", id: "oracle-1" },
      operation: "failed",
      name: "db-connect",
      timestamp: "2026-09-15T10:00:00.000Z",
      error: { type: "Error", message: connectionError("sunshine") },
      ...overrides
    }
  };
}

/**
 * The content hash stored beside each event (ADR-021, ADR-048), through the
 * ingestion route and read back from PostgreSQL.
 *
 * Each API process is booted the way an operator restarts one, with new keys
 * over the same database, so a resend straddling a rotation is the real path.
 */
describe("keyed content hash", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  const apiKeys = new Map<Keyring, string>();
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    // One API key per keyring, so authentication is never what a test measures.
    for (const [name, keyring] of [
      ["a", keyringA],
      ["b", keyringB]
    ] as const) {
      const issued = issueApiKey(keyring);
      await db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name,
        key_prefix: issued.keyPrefix,
        key_hash: issued.verifier,
        key_hash_key_id: issued.keyHashKeyId
      });
      apiKeys.set(keyring, issued.apiKey);
    }
    apiKeys.set(rotated, apiKeys.get(keyringB) ?? "");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const send = async (keyring: Keyring, payload: Record<string, unknown>) => {
    await app?.close();
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    return app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKeys.get(keyring) ?? ""}` },
      payload
    });
  };

  const storedHash = async (id: string): Promise<string> => {
    const row = await db("journey_events")
      .where({ project_id: projectId, id })
      .first("content_hash");
    return (row as { content_hash: string }).content_hash;
  };

  it("stores an HMAC under the current key, which the reviewer's oracle cannot match", async () => {
    const payload = body("evt_oracle");
    expect((await send(keyringA, payload)).statusCode).toBe(202);

    const stored = await storedHash("evt_oracle");
    expect(stored).toMatch(new RegExp(`^h1\\.${keyringA.current.id}\\.[0-9a-f]{64}$`));

    // The stored message is masked, as before.
    const row = await db("journey_events")
      .where({ project_id: projectId, id: "evt_oracle" })
      .first("error");
    expect(JSON.stringify(row.error)).not.toContain("sunshine");

    // The reproduction: rebuild the event from what a database read shows, try
    // each dictionary word, and compare unkeyed hashes with the stored value.
    const dictionary = ["password", "letmein", "hunter2", "dragon", "sunshine", "qwerty"];
    const digest = stored.split(".")[2];
    const hits = dictionary.filter((guess) => {
      const candidate = body("evt_oracle", {
        error: { type: "Error", message: connectionError(guess) }
      });
      const parsed = parseEnvelope(candidate);
      if (!parsed.ok) throw new Error("candidate did not parse");
      const unkeyed = legacyContentHash(parsed.event);
      const raw = createHash("sha256").update(JSON.stringify(candidate.event)).digest("hex");
      return unkeyed === stored || unkeyed === digest || raw === digest;
    });
    expect(hits).toEqual([]);
  });

  it("dedupes an identical resend under the current key, and refuses different content", async () => {
    const payload = body("evt_current");
    expect((await send(keyringA, payload)).json().data.duplicate).toBe(false);

    const resend = await send(keyringA, payload);
    expect(resend.statusCode).toBe(202);
    expect(resend.json().data.duplicate).toBe(true);

    const conflict = await send(keyringA, body("evt_current", { name: "different" }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("event_id_conflict");
  });

  it("dedupes a resend under the previous key during a rotation, and refuses different content", async () => {
    const payload = body("evt_previous");
    await send(keyringA, payload);
    expect((await storedHash("evt_previous")).startsWith(`h1.${keyringA.current.id}.`)).toBe(true);

    const resend = await send(rotated, payload);
    expect(resend.statusCode).toBe(202);
    expect(resend.json().data.duplicate).toBe(true);

    const conflict = await send(rotated, body("evt_previous", { name: "different" }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("event_id_conflict");

    // A duplicate rewrites nothing: the row keeps the hash it was written with.
    expect((await storedHash("evt_previous")).startsWith(`h1.${keyringA.current.id}.`)).toBe(true);
  });

  it("dedupes a resend against a legacy unprefixed hash, and refuses different content", async () => {
    const payload = body("evt_legacy");
    await send(keyringB, payload);
    // A row written before this release: its hash is the unkeyed SHA-256.
    const parsed = parseEnvelope(payload);
    if (!parsed.ok) throw new Error("payload did not parse");
    await db("journey_events")
      .where({ project_id: projectId, id: "evt_legacy" })
      .update({ content_hash: legacyContentHash(parsed.event) });

    const resend = await send(keyringB, payload);
    expect(resend.statusCode).toBe(202);
    expect(resend.json().data.duplicate).toBe(true);

    const conflict = await send(keyringB, body("evt_legacy", { name: "different" }));
    expect(conflict.statusCode).toBe(409);
  });

  it("refuses a resend once the key its hash names is removed", async () => {
    // The documented cost: a hash cannot be rewritten without the event, so a
    // duplicate delivery older than the rotation grace period is a 409, which
    // the SDK treats as permanent. The original row is untouched.
    const payload = body("evt_removed_key");
    await send(keyringA, payload);

    const resend = await send(keyringB, payload);
    expect(resend.statusCode).toBe(409);
    expect(resend.json().error.code).toBe("event_id_conflict");
    expect((await storedHash("evt_removed_key")).startsWith(`h1.${keyringA.current.id}.`)).toBe(
      true
    );
  });
});
