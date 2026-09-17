import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createKnexConfig, migrationsDirectory } from "./knex-config.js";
import { pendingMigrationCount } from "./migration-status.js";

interface Run {
  code: number;
  output: string;
}

const ENCRYPTION_KEY = "reset-test-encryption-key-5c1e9a7f02d4b836";

describe("the reset command", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const migrationCount = readdirSync(migrationsDirectory).filter((name) =>
    name.endsWith(".js")
  ).length;

  const cli = (args: string[], env: Record<string, string> = {}): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", "reset", ...args],
        {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            NODE_OPTIONS: "--conditions=development",
            DATABASE_URL: container.getConnectionUri(),
            ENCRYPTION_KEY,
            ...env
          }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, output: `${stdout}${stderr}` });
        }
      );
    });

  /** A project that only exists if nothing wiped the database. */
  const insertMarker = async (): Promise<void> => {
    await db("projects").insert({ name: "Keep me", slug: "keep-me" });
  };
  const markerCount = async (): Promise<number> =>
    Number((await db("projects").where({ slug: "keep-me" }).count({ n: "*" }))[0]?.["n"]);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
  });

  beforeEach(async () => {
    await db.migrate.latest();
    await db("projects").where({ slug: "keep-me" }).del();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("changes nothing without --yes", async () => {
    await insertMarker();

    const refused = await cli([]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Nothing was changed.");
    expect(refused.output).toContain("--yes");
    expect(await markerCount()).toBe(1);
    expect(await pendingMigrationCount(db)).toBe(0);
  });

  it("changes nothing under NODE_ENV=production, even with --yes", async () => {
    await insertMarker();

    const refused = await cli(["--yes"], { NODE_ENV: "production" });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("NODE_ENV=production");
    expect(await markerCount()).toBe(1);
  });

  it("changes nothing when the seed would fail for want of a key", async () => {
    await insertMarker();

    const refused = await cli(["--yes"], { ENCRYPTION_KEY: "" });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("ENCRYPTION_KEY");
    expect(await markerCount()).toBe(1);
    expect(await pendingMigrationCount(db)).toBe(0);
  });

  it("rolls back every migration, including 019's concurrent indexes, then migrates and seeds", async () => {
    await insertMarker();
    // Two batches, so `reset` has to roll back more than the last one.
    await db.migrate.down({ name: "019_journey_browse_indexes.js" });
    await db.migrate.latest();

    const reset = await cli(["--yes"]);
    expect(reset.output).toContain(`Rolled back ${String(migrationCount)} migrations.`);
    expect(reset.code).toBe(0);
    expect(reset.output).toContain(`Applied ${String(migrationCount)} migrations.`);
    expect(reset.output).toContain("Local seed applied.");

    expect(await markerCount()).toBe(0);
    expect(await pendingMigrationCount(db)).toBe(0);
    expect(await db("projects").pluck("slug")).toEqual(["local"]);
    expect(await db("api_keys").count({ n: "*" })).toEqual([{ n: "1" }]);
    const indexes = await db("pg_indexes")
      .whereIn("indexname", ["journeys_project_recent_idx", "entity_aliases_displayable_idx"])
      .pluck("indexname");
    expect(indexes.sort()).toEqual([
      "entity_aliases_displayable_idx",
      "journeys_project_recent_idx"
    ]);
  });

  it("works on a database with no schema yet", async () => {
    await db.migrate.rollback({}, true);

    const reset = await cli(["--yes"]);
    expect(reset.code).toBe(0);
    expect(reset.output).toContain("Nothing to roll back.");
    expect(reset.output).toContain(`Applied ${String(migrationCount)} migrations.`);
    expect(await pendingMigrationCount(db)).toBe(0);
  });
});
