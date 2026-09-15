import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { createKeyring, verifyApiKeyWithKeyring } from "@flight-recorder/payload-security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { seedLocal } from "./seed-local.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

describe("seedLocal", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("creates a project, environment, and API key", async () => {
    const result = await seedLocal(db, keyring);
    expect(result.apiKey.startsWith("fr_")).toBe(true);
    expect(await db("projects").count({ n: "*" }).first()).toEqual({ n: "1" });
    expect(await db("environments").count({ n: "*" }).first()).toEqual({ n: "1" });
    expect(await db("api_keys").count({ n: "*" }).first()).toEqual({ n: "1" });
  });

  it("is idempotent and does not duplicate rows", async () => {
    await seedLocal(db, keyring);
    expect(await db("projects").count({ n: "*" }).first()).toEqual({ n: "1" });
    expect(await db("environments").count({ n: "*" }).first()).toEqual({ n: "1" });
  });

  it("stores only a verifier, never the key itself", async () => {
    const result = await seedLocal(db, keyring);
    const row = (await db("api_keys").where({ key_prefix: result.keyPrefix }).first()) as {
      key_hash: string;
    };
    expect(row.key_hash).not.toContain(result.apiKey);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues a key labelled with the current key's id", async () => {
    const result = await seedLocal(db, keyring);
    const row = (await db("api_keys").where({ key_prefix: result.keyPrefix }).first()) as {
      key_hash: string;
      key_hash_key_id: string | null;
    };
    expect(row.key_hash_key_id).toBe(keyring.current.id);
    expect(
      verifyApiKeyWithKeyring(keyring, result.apiKey, {
        keyHash: row.key_hash,
        keyHashKeyId: row.key_hash_key_id
      })
    ).toEqual({ ok: true, migrate: null });
  });
});
