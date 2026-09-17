import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { pendingMigrationCount } from "./migration-status.js";

interface Run {
  code: number;
  output: string;
}

describe("the migrate commands", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

  const cli = (command: string): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        tsx,
        ["src/cli.ts", command],
        {
          cwd: packageRoot,
          env: {
            PATH: process.env["PATH"] ?? "",
            NODE_OPTIONS: "--conditions=development",
            DATABASE_URL: container.getConnectionUri()
          }
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, output: `${stdout}${stderr}` });
        }
      );
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("recovers with migrate:unlock from a lock a killed migrate left behind", async () => {
    // What `kill -9` during migration 013 leaves: that migration runs outside a
    // transaction, so knex takes its lock in a transaction of its own that has
    // already committed, and nothing releases it. Every later migrate refuses.
    await db.migrate.down({ name: "013_journeys_status_recent_index.js" });
    await db("knex_migrations_lock").update({ is_locked: 1 });

    const refused = await cli("migrate");
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/locked/i);
    expect(await pendingMigrationCount(db)).toBe(1);

    const unlocked = await cli("migrate:unlock");
    expect(unlocked.code).toBe(0);
    expect(unlocked.output).toContain("Migration lock released.");
    expect(await db("knex_migrations_lock").first("is_locked")).toEqual({ is_locked: 0 });

    const applied = await cli("migrate");
    expect(applied.code).toBe(0);
    expect(applied.output).toContain("013_journeys_status_recent_index.js");
    expect(await pendingMigrationCount(db)).toBe(0);
  });
});
