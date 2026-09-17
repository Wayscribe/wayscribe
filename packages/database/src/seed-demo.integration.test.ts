import { createKeyring, verifyApiKeyWithKeyring } from "@wayscribe/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { seedDemo } from "./seed-demo.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyring = createKeyring(KEY_A);

interface KeyRow {
  key_hash: string;
  key_hash_key_id: string | null;
}

const demoKeyRow = async (db: Knex): Promise<KeyRow> =>
  (await db("api_keys").where({ key_prefix: "fr_demo00000" }).first()) as KeyRow;

const verifies = (ring: ReturnType<typeof createKeyring>, row: KeyRow): unknown =>
  verifyApiKeyWithKeyring(ring, DEMO_KEY, {
    keyHash: row.key_hash,
    keyHashKeyId: row.key_hash_key_id
  });
const DEMO_KEY = "fr_demo00000000000000000000000000000";

describe("seedDemo", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("registers a key that verifies, labelled with the current key", async () => {
    await seedDemo(db, keyring, DEMO_KEY);
    const row = await demoKeyRow(db);
    expect(row.key_hash_key_id).toBe(keyring.current.id);
    expect(verifies(keyring, row)).toEqual({ ok: true, migrate: null });
  });

  it("is idempotent, including the key", async () => {
    const first = await seedDemo(db, keyring, DEMO_KEY);
    const second = await seedDemo(db, keyring, DEMO_KEY);
    expect(second.projectId).toBe(first.projectId);
    expect(second.environmentId).toBe(first.environmentId);
    // Compose runs the bootstrap on every `up`. A second row sharing the prefix
    // would make lookup by prefix ambiguous, and authentication resolves a key
    // by its prefix before it verifies anything.
    expect(
      await db("api_keys").where({ key_prefix: "fr_demo00000" }).count({ n: "*" }).first()
    ).toEqual({ n: "1" });
  });

  it("re-verifies an existing key after the encryption key rotates", async () => {
    await seedDemo(db, keyring, DEMO_KEY);
    const rotated = createKeyring(KEY_B, KEY_A);
    await seedDemo(db, rotated, DEMO_KEY);

    const row = await demoKeyRow(db);
    expect(row.key_hash_key_id).toBe(rotated.current.id);
    expect(verifies(createKeyring(KEY_B), row)).toEqual({ ok: true, migrate: null });
    expect(verifies(keyring, row)).toEqual({ ok: false });
  });
});
