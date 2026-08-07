import { deriveSubkeys, verifyApiKey } from "@flight-recorder/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { seedDemo } from "./seed-demo.js";

const MASTER_KEY = "0123456789abcdef0123456789abcdef";
const DEMO_KEY = "fr_demo00000000000000000000000000000";

describe("seedDemo", () => {
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

  it("registers a key that verifies", async () => {
    await seedDemo(db, MASTER_KEY, DEMO_KEY);
    const row = (await db("api_keys").where({ key_prefix: "fr_demo00000" }).first()) as {
      key_hash: string;
    };
    expect(verifyApiKey(deriveSubkeys(MASTER_KEY).apiKey, DEMO_KEY, row.key_hash)).toBe(true);
  });

  it("is idempotent, including the key", async () => {
    const first = await seedDemo(db, MASTER_KEY, DEMO_KEY);
    const second = await seedDemo(db, MASTER_KEY, DEMO_KEY);
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
    await seedDemo(db, MASTER_KEY, DEMO_KEY);
    const rotated = "fedcba9876543210fedcba9876543210";
    await seedDemo(db, rotated, DEMO_KEY);

    const row = (await db("api_keys").where({ key_prefix: "fr_demo00000" }).first()) as {
      key_hash: string;
    };
    expect(verifyApiKey(deriveSubkeys(rotated).apiKey, DEMO_KEY, row.key_hash)).toBe(true);
    expect(verifyApiKey(deriveSubkeys(MASTER_KEY).apiKey, DEMO_KEY, row.key_hash)).toBe(false);
  });
});
