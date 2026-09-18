import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { migrationStatusReadOnly, pendingMigrationCount } from "./migration-status.js";

describe("migrations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("counts pending migrations read-only, agreeing with knex, without creating its tables", async () => {
    // First, before anything has created knex's tables.
    const status = await migrationStatusReadOnly(db);
    expect(status.unknown).toEqual([]);
    const tables: unknown = await db.raw("select to_regclass('knex_migrations') as found");
    expect((tables as { rows: unknown[] }).rows).toEqual([{ found: null }]);
    expect(status.pending).toHaveLength(await pendingMigrationCount(db));
  });

  it("counts each migration exactly once before running them", async () => {
    // Exact, not greater-than: a loose assertion here hid a defect where
    // declaration files were counted as migrations, because `.d.ts` ends in
    // `.ts`. Update this number when a migration is added.
    expect(await pendingMigrationCount(db)).toBe(21);
  });

  it("applies migrations and creates the projects table", async () => {
    await db.migrate.latest();
    expect(await db.schema.hasTable("projects")).toBe(true);
  });

  it("names an applied migration this build does not have", async () => {
    await db.migrate.latest();
    await db("knex_migrations").insert({
      name: "099_from_a_newer_build.js",
      batch: 99,
      migration_time: new Date()
    });
    try {
      expect(await migrationStatusReadOnly(db)).toEqual({
        pending: [],
        unknown: ["099_from_a_newer_build.js"]
      });
    } finally {
      await db("knex_migrations").where({ name: "099_from_a_newer_build.js" }).del();
    }
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

  it("migrates as a role with privileges on its schema alone, and installs no extension", async () => {
    // docs/OPERATIONS.md §1 promises an ordinary role and no extensions.
    // Migration 001 ran `create extension pgcrypto`, which needs CREATE on the
    // database, so this role failed at the first migration with a stack trace.
    await db.raw("create database ordinary_role");
    await db.raw("create role ordinary_migrator login password 'ordinary-migrator-pw'");
    const url = new URL(container.getConnectionUri());
    url.pathname = "/ordinary_role";
    const owner = knex(createKnexConfig(url.toString()));
    url.username = "ordinary_migrator";
    url.password = "ordinary-migrator-pw";
    const migrator = knex(createKnexConfig(url.toString()));
    try {
      await owner.raw("revoke create on database ordinary_role from public");
      await owner.raw("grant usage, create on schema public to ordinary_migrator");

      await migrator.migrate.latest();

      expect(await pendingMigrationCount(migrator)).toBe(0);
      const extensions: unknown = await owner.raw("select extname from pg_extension order by 1");
      expect((extensions as { rows: unknown[] }).rows).toEqual([{ extname: "plpgsql" }]);
    } finally {
      await migrator.destroy();
      await owner.destroy();
    }
  });

  it("rolls back cleanly", async () => {
    await db.migrate.rollback();
    expect(await db.schema.hasTable("projects")).toBe(false);
  });
});
