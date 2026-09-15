import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { pendingMigrationCount } from "./migration-status.js";

describe("migrations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("counts each migration exactly once before running them", async () => {
    // Exact, not greater-than: a loose assertion here hid a defect where
    // declaration files were counted as migrations, because `.d.ts` ends in
    // `.ts`. Update this number when a migration is added.
    expect(await pendingMigrationCount(db)).toBe(15);
  });

  it("applies migrations and creates the projects table", async () => {
    await db.migrate.latest();
    expect(await db.schema.hasTable("projects")).toBe(true);
  });

  it("reports zero pending migrations once current", async () => {
    expect(await pendingMigrationCount(db)).toBe(0);
  });

  it("is idempotent on re-run", async () => {
    await db.migrate.latest();
    expect(await pendingMigrationCount(db)).toBe(0);
  });

  it("enforces the unique slug constraint", async () => {
    await db("projects").insert({ name: "First", slug: "duplicate-slug" });
    await expect(
      db("projects").insert({ name: "Second", slug: "duplicate-slug" })
    ).rejects.toThrow();
  });

  it("rolls back cleanly", async () => {
    await db.migrate.rollback();
    expect(await db.schema.hasTable("projects")).toBe(false);
  });
});
